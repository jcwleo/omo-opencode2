import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { Message } from "@opencode/ai"
import { Agent, type Plugin } from "@opencode/plugin"
import type { GitMemoryRepo, MemoryIdentity } from "../omo/core.generated.js"
import { MessageNotes } from "../omo/message-notes.ts"
import { appendToolText, isRecord, omoLogger } from "../omo/shared.ts"
import { categoryModel, digestConversation } from "./curation.ts"
import {
  conversationText,
  escapeMarkup,
  hintRefusal,
  loadRecallNotes,
  pickCandidates,
  redactSecrets,
  renderRecalledMemory,
  termsOf,
  type RecallCandidate,
  type RecallNote,
} from "./recall-notes.ts"

export const RECALL_AGENT_ID = "omo-memory-recall"
export const RECALL_NUDGE_TOOL = "recall_nudge"
const RECALL_SOURCE = "omo-memory-recall"
const PERSONA_PATH = fileURLToPath(new URL("./personas/recall.md", import.meta.url))
const RECALL_CATEGORY = "quick"
const MAX_CANDIDATES = 4
const MAX_ITEMS_PER_TURN = 2
const MAX_PER_SESSION = 6
const MAX_REFUSALS = 2
const JUDGE_TIMEOUT_MS = 90_000
const DIGEST_MESSAGES = 12
const DIGEST_CHARS = 6_000
const TASK_CHARS = 2_000
const CANDIDATE_BODY_CHARS = 800

const NUDGE_INPUT = {
  type: "object",
  properties: {
    path: { type: "string", description: 'A path copied exactly from a <candidate path="..."> in this turn\'s envelope.' },
    hint: { type: "string", description: 'One sentence, at most 200 characters, on one line, stating what the note records ("the note records that ..."), in the language of <task>.' },
  },
  required: ["path", "hint"],
  additionalProperties: false,
} as const

type Delivery = { readonly path: string; readonly block: string }
type RootSession = {
  readonly root: Promise<boolean>
  trigger?: string
  judging: boolean
  readonly delivered: Set<string>
  readonly declined: Map<string, number>
  pending: Delivery[]
}
type Judgment = { readonly parent: RootSession; readonly candidates: ReadonlyMap<string, number>; readonly maxItems: number; readonly accepted: Set<string>; refusals: number }

export interface Recall {
  readonly enabled: boolean
  readonly owns: (sessionID: string) => boolean
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(text.length - limit)}`
}

function attribute(value: string): string {
  return escapeMarkup(value).replace(/\r?\n/g, "&#10;")
}

function guarded(text: string): string {
  return escapeMarkup(redactSecrets(text))
}

function renderRequest(task: string, messages: readonly Message[], candidates: readonly RecallCandidate[], maxItems: number): string {
  const recent = messages.slice(-DIGEST_MESSAGES)
  return [
    `<recall-request max-items="${maxItems}">`,
    `<task>${guarded(clip(task.trim(), TASK_CHARS))}</task>`,
    `<conversation omitted="${messages.length - recent.length}">`,
    guarded(tail(digestConversation(recent).text, DIGEST_CHARS)),
    "</conversation>",
    "<candidates>",
    ...candidates.map(({ note }) =>
      [`<candidate path="${attribute(note.path)}" description="${attribute(redactSecrets(note.description))}">`, guarded(clip(note.body.trim(), CANDIDATE_BODY_CHARS)), "</candidate>"].join("\n"),
    ),
    "</candidates>",
    "</recall-request>",
  ].join("\n")
}

async function outlasts(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), ms)
  })
  try {
    return await Promise.race([work.then(() => false as const), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function surfaced(state: RootSession, path: string): boolean {
  return state.delivered.has(path) || state.pending.some((entry) => entry.path === path)
}

function refusalFor(judgment: Judgment, params: Readonly<Record<string, unknown>>): string | undefined {
  if (judgment.refusals >= MAX_REFUSALS) return "this turn is over; end it without another call"
  if (judgment.accepted.size >= judgment.maxItems) return `this turn already made its ${judgment.maxItems} nudge(s); end it`
  const path = typeof params.path === "string" ? params.path.trim() : ""
  if (!judgment.candidates.has(path)) return `"${path}" is not a candidate in this turn's envelope; copy a <candidate path> exactly`
  if (judgment.accepted.has(path) || surfaced(judgment.parent, path)) return `"${path}" was already surfaced in this session`
  return hintRefusal(typeof params.hint === "string" ? params.hint : "")
}

// After omo's Kibitzer: a prompt that shares words with stored notes gets one hidden `quick` judge, and its accepted
// nudge rides on the next tool result, or on the next user message once the turn is over, never on the system prompt.
export async function registerRecall(ctx: Plugin.Context, identity: MemoryIdentity, repo: GitMemoryRepo, enabled: boolean): Promise<Recall> {
  if (!enabled) return { enabled: false, owns: () => false }
  const persona = await readFile(PERSONA_PATH, "utf8")
  const judgments = new Map<string, Judgment>()
  // Kept after a judge ends: its execution events can arrive after `wait` returns.
  const judgeSessions = new Set<string>()
  const roots = new Map<string, RootSession>()
  const turnNotes = new MessageNotes()
  let corpus: { readonly head: string; readonly notes: Promise<RecallNote[]> } | undefined

  const notesAt = (head: string): Promise<RecallNote[]> => {
    if (corpus !== undefined && corpus.head === head) return corpus.notes
    const loaded = repo.lsTree(head).then((paths) => loadRecallNotes(identity.paths.repo, paths))
    corpus = { head, notes: loaded }
    loaded.catch(() => {
      if (corpus?.notes === loaded) corpus = undefined
    })
    return loaded
  }

  const rootFor = (sessionID: string): RootSession => {
    const existing = roots.get(sessionID)
    if (existing !== undefined) return existing
    const created: RootSession = {
      root: ctx.session.get({ sessionID }).then(
        (session) => session.parentID === undefined,
        () => false,
      ),
      judging: false,
      delivered: new Set(),
      declined: new Map(),
      pending: [],
    }
    roots.set(sessionID, created)
    return created
  }

  const deliver = (state: RootSession): string | undefined => {
    if (state.pending.length === 0) return undefined
    const batch = state.pending
    state.pending = []
    for (const entry of batch) state.delivered.add(entry.path)
    return batch.map((entry) => entry.block).join("\n\n")
  }

  await ctx.agent.transform((editor) => {
    editor.update(RECALL_AGENT_ID, (agent) => {
      agent.name = Agent.Name.make("Memory recall")
      agent.description = "Background memory recall judge run by omo-opencode2"
      agent.mode = "primary"
      agent.hidden = true
      agent.system = persona
      agent.permissions = [...agent.permissions, { action: "*", resource: "*", effect: "deny" as const }, { action: RECALL_NUDGE_TOOL, resource: "*", effect: "allow" as const }]
    })
  })

  await ctx.tool.transform((editor) => {
    editor.add({
      name: RECALL_NUDGE_TOOL,
      description: "Surface one stored memory note to the primary agent with a one-sentence observation of what it records. Only the memory recall judge can call it.",
      input: NUDGE_INPUT,
      options: { codemode: false },
      execute: async (input, context) => {
        const judgment = judgments.get(context.sessionID)
        if (judgment === undefined) throw new Error(`only the memory recall judge can call ${RECALL_NUDGE_TOOL}`)
        const params = isRecord(input) ? input : {}
        const refusal = refusalFor(judgment, params)
        if (refusal !== undefined) {
          judgment.refusals += 1
          throw new Error(refusal)
        }
        const path = String(params.path).trim()
        judgment.accepted.add(path)
        judgment.parent.pending.push({ path, block: renderRecalledMemory(path, String(params.hint)) })
        return { content: `recorded: ${path} reaches the primary agent at its next step`, metadata: {} }
      },
    })
  })

  const judge = async (parentID: string, state: RootSession, task: string, messages: readonly Message[]): Promise<void> => {
    state.judging = true
    try {
      const room = MAX_PER_SESSION - state.delivered.size - state.pending.length
      const head = room > 0 ? await repo.head() : null
      if (head === null) return
      const mentioned = conversationText(messages)
      const skip = (path: string, score: number): boolean => surfaced(state, path) || mentioned.includes(path) || (state.declined.get(path) ?? -1) >= score
      const candidates = pickCandidates(await notesAt(head), termsOf(task), skip, MAX_CANDIDATES)
      if (candidates.length === 0) return
      const judgment: Judgment = { parent: state, candidates: new Map(candidates.map((entry) => [entry.note.path, entry.score])), maxItems: Math.min(MAX_ITEMS_PER_TURN, room), accepted: new Set(), refusals: 0 }
      const model = await categoryModel(ctx, RECALL_CATEGORY, parentID)
      const session = await ctx.session.create({ parentID, title: "memory recall", agent: RECALL_AGENT_ID, ...(model === undefined ? {} : { model }), metadata: { source: RECALL_SOURCE } })
      judgeSessions.add(session.id)
      judgments.set(session.id, judgment)
      try {
        await ctx.session.prompt({ sessionID: session.id, text: renderRequest(task, messages, candidates, judgment.maxItems), metadata: { source: RECALL_SOURCE } })
        if (await outlasts(ctx.session.wait({ sessionID: session.id }), JUDGE_TIMEOUT_MS)) {
          omoLogger.warn(`memory recall judge ${session.id} passed ${JUDGE_TIMEOUT_MS / 1000} s; interrupting it`)
          await ctx.session.interrupt({ sessionID: session.id })
        }
      } finally {
        judgments.delete(session.id)
        for (const [path, score] of judgment.candidates) if (!judgment.accepted.has(path)) state.declined.set(path, score)
        // One judge runs per prompt, so finished ones leave the session list instead of piling up under the parent.
        await ctx.session.remove({ sessionID: session.id }).catch((error: unknown) => omoLogger.warn(`memory recall could not remove judge session ${session.id}`, error))
      }
    } catch (error) {
      omoLogger.warn("memory recall judge failed", error)
    } finally {
      state.judging = false
    }
  }

  await ctx.session.hook("prompt", async (event) => {
    if (judgeSessions.has(event.sessionID) || typeof event.metadata?.source === "string") return
    const state = rootFor(event.sessionID)
    if (!(await state.root)) return
    const blocks = deliver(state)
    if (blocks !== undefined) turnNotes.add(event.sessionID, event.messageID, blocks)
    state.trigger = event.prompt.text
  })

  await ctx.session.hook("compaction", (event) => {
    turnNotes.clear(event.sessionID)
  })

  await ctx.session.hook("context", (event) => {
    if (judgeSessions.has(event.sessionID)) {
      for (const name of Object.keys(event.tools)) if (name !== RECALL_NUDGE_TOOL) delete event.tools[name]
      return
    }
    delete event.tools[RECALL_NUDGE_TOOL]
    turnNotes.apply(event.sessionID, event.messages)
    const state = roots.get(event.sessionID)
    if (state?.trigger === undefined || state.judging) return
    const task = state.trigger
    state.trigger = undefined
    void judge(event.sessionID, state, task, [...event.messages])
  })

  await ctx.tool.hook("execute.after", (event) => {
    if (event.status !== "completed" || judgeSessions.has(event.sessionID)) return
    const state = roots.get(event.sessionID)
    const blocks = state === undefined ? undefined : deliver(state)
    if (blocks !== undefined) event.result = { ...event.result, content: appendToolText(event.result.content, blocks) }
  })

  return { enabled: true, owns: (sessionID) => judgeSessions.has(sessionID) }
}
