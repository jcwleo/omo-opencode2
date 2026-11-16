import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { Message } from "@opencode/ai"
import { Agent, type Plugin } from "@opencode/plugin"
import type { GitMemoryRepo, MemoryIdentity } from "../omo/core.generated.js"
import { MessageNotes } from "../omo/message-notes.ts"
import { appendToolText, isRecord, omoLogger } from "../omo/shared.ts"
import { categoryModel, digestConversation } from "./curation.ts"
import { conversationText, escapeMarkup, hintRefusal, loadRecallNotes, noteCards, redactSecrets, renderRecalledMemory, searchNotes, termsOf, type RecallNote, type SearchHit } from "./recall-notes.ts"

export const RECALL_AGENT_ID = "omo-memory-recall"
const RECALL_SOURCE = "omo-memory-recall"
const PERSONA_PATH = fileURLToPath(new URL("./personas/recall.md", import.meta.url))
const RECALL_CATEGORY = "quick"
const MAX_ITEMS_PER_TURN = 2
const MAX_PER_SESSION = 6
const CALL_TIMEOUT_MS = 60_000
const DIGEST_MESSAGES = 12
const DIGEST_CHARS = 6_000
const TASK_CHARS = 2_000
const MIN_PROMPT_CHARS = 6
const ACK = /^(?:응|네|넵|예|ㅇㅇ|ㅇㅋ|오케이|ok|okay|yes|좋아|진행해|진행|고마워|감사|ㄱㄱ|해줘|그래)[.!~ ]*$/i

type Delivery = { readonly path: string; readonly block: string }
type RootSession = {
  readonly root: Promise<boolean>
  trigger?: string
  judging: boolean
  readonly delivered: Set<string>
  readonly declined: Set<string>
  pending: Delivery[]
}
type Nudge = { readonly path: string; readonly hint: string }
type Decision = { readonly search: readonly string[]; readonly nudges: readonly Nudge[] }

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

function guarded(text: string): string {
  return escapeMarkup(redactSecrets(text))
}

function renderRequest(task: string, messages: readonly Message[], notes: readonly RecallNote[], declined: readonly string[], maxItems: number): string {
  const recent = messages.slice(-DIGEST_MESSAGES)
  return [
    `<recall-request max-items="${maxItems}">`,
    `<task>${guarded(clip(task, TASK_CHARS))}</task>`,
    `<conversation omitted="${messages.length - recent.length}">`,
    guarded(tail(digestConversation(recent).text, DIGEST_CHARS)),
    "</conversation>",
    "<cards>",
    guarded(noteCards(notes)),
    "</cards>",
    ...(declined.length === 0 ? [] : ["<declined>", ...declined.map(escapeMarkup), "</declined>"]),
    "</recall-request>",
  ].join("\n")
}

function renderHits(terms: readonly string[], hits: readonly SearchHit[]): string {
  const body = hits.length === 0 ? "no matching lines" : hits.map((hit) => [hit.path, ...hit.lines.map((line) => `  - ${line}`)].join("\n")).join("\n\n")
  return [`<search-results terms="${escapeMarkup(terms.join(", "))}">`, guarded(body), "</search-results>"].join("\n")
}

function parseDecision(text: string): Decision {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  let value: unknown
  try {
    value = start < 0 || end < start ? undefined : JSON.parse(text.slice(start, end + 1))
  } catch {
    value = undefined
  }
  if (!isRecord(value)) return { search: [], nudges: [] }
  const search = Array.isArray(value.search) ? value.search.filter((term): term is string => typeof term === "string") : []
  const nudges = Array.isArray(value.nudges)
    ? value.nudges.flatMap((entry): Nudge[] => (isRecord(entry) && typeof entry.path === "string" && typeof entry.hint === "string" ? [{ path: entry.path.trim(), hint: entry.hint }] : []))
    : []
  return { search, nudges }
}

async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`memory recall call passed ${ms / 1000} s`)), ms)
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

function surfaced(state: RootSession, path: string): boolean {
  return state.delivered.has(path) || state.pending.some((entry) => entry.path === path)
}

// After omo's Kibitzer: each real user prompt gets one quick judge that sees every note's card, may word-search the
// notes once, and answers in JSON. An accepted nudge rides on the next tool result, or on the next user message once
// the turn is over, never on the system prompt.
export async function registerRecall(ctx: Plugin.Context, identity: MemoryIdentity, repo: GitMemoryRepo, enabled: boolean): Promise<Recall> {
  if (!enabled) return { enabled: false, owns: () => false }
  const persona = await readFile(PERSONA_PATH, "utf8")
  const judgeSessions = new Set<string>()
  const roots = new Map<string, RootSession>()
  const turnNotes = new MessageNotes()
  let corpus: { readonly head: string; readonly notes: Promise<RecallNote[]> } | undefined

  await ctx.agent.transform((editor) => {
    editor.update(RECALL_AGENT_ID, (agent) => {
      agent.name = Agent.Name.make("Memory recall")
      agent.description = "Background memory recall judge run by omo-opencode2"
      agent.mode = "primary"
      agent.hidden = true
      agent.system = "You are a memory recall judge. Follow the user message exactly and reply with one JSON object."
      agent.permissions = [...agent.permissions, { action: "*", resource: "*", effect: "deny" as const }]
    })
  })

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
      declined: new Set(),
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

  const judge = async (parentID: string, state: RootSession, task: string, messages: readonly Message[]): Promise<void> => {
    state.judging = true
    try {
      const room = MAX_PER_SESSION - state.delivered.size - state.pending.length
      const head = room > 0 ? await repo.head() : null
      if (head === null) return
      const mentioned = conversationText(messages)
      const notes = (await notesAt(head)).filter((note) => !surfaced(state, note.path) && !mentioned.includes(note.path))
      if (notes.length === 0) return
      const paths = new Set(notes.map((note) => note.path))
      const declined = [...state.declined].filter((path) => paths.has(path))
      const maxItems = Math.min(MAX_ITEMS_PER_TURN, room)
      const envelope = `${persona}\n\n${renderRequest(task, messages, notes, declined, maxItems)}`
      const model = await categoryModel(ctx, RECALL_CATEGORY, parentID)
      // generate runs no agent loop: a prompted child session would post its last reply into the parent and wake it.
      const session = await ctx.session.create({ parentID, title: "memory recall", agent: RECALL_AGENT_ID, ...(model === undefined ? {} : { model }), metadata: { source: RECALL_SOURCE } })
      judgeSessions.add(session.id)
      try {
        const ask = async (prompt: string): Promise<Decision> => parseDecision((await within(ctx.session.generate({ sessionID: session.id, prompt }), CALL_TIMEOUT_MS)).text)
        let decision = await ask(`${envelope}\n\nThis is your first pass.`)
        const seen = new Set<string>()
        if (decision.nudges.length === 0 && decision.search.length > 0) {
          const hits = searchNotes(notes, termsOf(decision.search.join(" ")))
          for (const hit of hits) seen.add(hit.path)
          decision = await ask(`${envelope}\n\n${renderHits(decision.search, hits)}\n\nThis is your final pass: decide now.`)
        }
        const accepted = new Set<string>()
        for (const nudge of decision.nudges) {
          if (accepted.size >= maxItems || !paths.has(nudge.path) || accepted.has(nudge.path) || hintRefusal(nudge.hint) !== undefined) continue
          accepted.add(nudge.path)
          state.pending.push({ path: nudge.path, block: renderRecalledMemory(nudge.path, nudge.hint) })
          omoLogger.info(`memory recall surfaced ${nudge.path}`)
        }
        for (const path of seen) if (!accepted.has(path)) state.declined.add(path)
      } finally {
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
    const text = event.prompt.text.trim()
    if (text.length >= MIN_PROMPT_CHARS && !ACK.test(text)) state.trigger = text
  })

  await ctx.session.hook("compaction", (event) => {
    turnNotes.clear(event.sessionID)
  })

  await ctx.session.hook("context", (event) => {
    if (judgeSessions.has(event.sessionID)) return
    turnNotes.apply(event.sessionID, event.messages)
    const state = roots.get(event.sessionID)
    if (state?.trigger === undefined || state.judging) return
    const task = state.trigger
    state.trigger = undefined
    void judge(event.sessionID, state, task, [...event.messages])
  })

  await ctx.tool.hook("execute.after", (event) => {
    if (event.status !== "completed") return
    const state = roots.get(event.sessionID)
    const blocks = state === undefined ? undefined : deliver(state)
    if (blocks !== undefined) event.result = { ...event.result, content: appendToolText(event.result.content, blocks) }
  })

  return { enabled: true, owns: (sessionID) => judgeSessions.has(sessionID) }
}
