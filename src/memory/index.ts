import { join } from "node:path"
import type { Message } from "@opencode/ai"
import type { Plugin } from "@opencode/plugin"
import { SESSION_ID_PREFIX } from "../hooks/ulw-execute-continuation.ts"
import {
  compileMemoryBlockAtRevision,
  GitMemoryRepo,
  isAutoAgentValue,
  isEmptyProjectedChanges,
  loadOmoConfig,
  markMemoryBlock,
  OmoMemorySettingsSchema,
  projectedChangesBetween,
  renderProjectedChangesLine,
  resolveAutoIdentity,
  resolveMemoryIdentity,
  type MemoryIdentity,
  type OmoMemorySettings,
} from "../omo/core.generated.js"
import { omoLogger } from "../omo/shared.ts"
import { loadSkills, registerSkills } from "../skills/index.ts"
import { registerMemoryTool } from "./tool.ts"

const NUDGE_TOKEN = "user turns since your last memory save"
const NUDGE_GIT_TIMEOUT_MS = 5_000
const NUDGE_SCAN_LIMIT = 20
const SESSION_START_MARGIN_MS = 60 * 60 * 1000

type Exchange = { readonly proposal: string; readonly reply: string }
type Turn = { readonly revision: string | null; readonly notice?: string }

type SessionMemory = {
  readonly commitSessionId: string
  readonly startedAt: Date
  userTurns: number
  consentExchange: readonly Exchange[]
  pin?: { readonly revision: string | null; readonly noticedThrough: string | null }
  turn?: Promise<Turn | undefined>
  saveScan?: { readonly head: string; readonly savedTurn: number | undefined }
}

function memorySettings(directory: string): OmoMemorySettings {
  return loadOmoConfig({ cwd: directory, harness: "opencode" }).config.memory ?? OmoMemorySettingsSchema.parse({})
}

function memoryIdentity(directory: string, settings: OmoMemorySettings): MemoryIdentity {
  return isAutoAgentValue(settings.agent)
    ? resolveAutoIdentity(directory, process.env, settings.auto_identity)
    : resolveMemoryIdentity(settings.agent, directory, process.env)
}

// The compiled block names files as `$MEMORY_DIR/...`, which OpenCode's tools do not expand.
function withMemoryDir(block: string, repoPath: string): string {
  const line = `- MEMORY_DIR: ${repoPath}`
  const end = block.lastIndexOf("</memory_metadata>")
  return end < 0 ? `${block}\n${line}` : `${block.slice(0, end)}${line}\n${block.slice(end)}`
}

function messageText(message: Message): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}

// omo-senpi's consent rule: only the newest user message, and only when the message right before it is the
// assistant's proposal, can be cited as the user's approval.
function pendingConsentExchange(messages: readonly Message[]): Exchange[] {
  const conversation = messages.filter((message) => message.role === "user" || message.role === "assistant")
  const reply = conversation.at(-1)
  const proposal = conversation.at(-2)
  if (reply?.role !== "user" || proposal?.role !== "assistant") return []
  const proposalText = messageText(proposal)
  return proposalText.trim().length === 0 ? [] : [{ proposal: proposalText, reply: messageText(reply) }]
}

// Senpi sends the notice as its own hidden message; OpenCode has none, so it rides on the turn's user message
// for this turn's requests only and the system prompt keeps the pinned bytes.
function appendToLastUserMessage(messages: Message[], text: string): void {
  const index = messages.findLastIndex((message) => message.role === "user")
  const message = messages[index]
  if (message === undefined) return
  const MessageClass = message.constructor as unknown as new (fields: Message) => Message
  messages[index] = new MessageClass({ ...message, content: [...message.content, { type: "text", text }] })
}

function parseTurn(value: string | undefined): number | undefined {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined
}

export async function registerMemory(ctx: Plugin.Context, takenSkillIds: ReadonlySet<string>): Promise<{ identity: string; skills: number } | undefined> {
  const directory = ctx.location.directory
  const settings = memorySettings(directory)
  if (!settings.enabled) return undefined
  const identity = memoryIdentity(directory, settings)
  const repo = new GitMemoryRepo({ dir: identity.paths.repo, agentId: identity.id })
  const sessions = new Map<string, SessionMemory>()
  const blocks = new Map<string, Promise<string>>()

  const stateFor = (sessionID: string): SessionMemory => {
    const existing = sessions.get(sessionID)
    if (existing !== undefined) return existing
    const created: SessionMemory = { commitSessionId: `${SESSION_ID_PREFIX}${sessionID}`, startedAt: new Date(), userTurns: 0, consentExchange: [] }
    sessions.set(sessionID, created)
    return created
  }

  const blockAt = (revision: string | null): Promise<string> => {
    const key = revision ?? "empty"
    const cached = blocks.get(key)
    if (cached !== undefined) return cached
    const compiled = compileMemoryBlockAtRevision(repo, revision, { agentId: identity.id }).then((block) =>
      markMemoryBlock(identity.id, withMemoryDir(block, identity.paths.repo)),
    )
    blocks.set(key, compiled)
    compiled.catch(() => blocks.delete(key))
    return compiled
  }

  // Ported from omo-senpi nudge-wiring: read only this session's commits, and after the first scan only the new ones.
  const latestSaveTurn = async (state: SessionMemory, head: string): Promise<number | undefined> => {
    const previous = state.saveScan
    if (previous?.head === head) return previous.savedTurn
    const commits = await repo.log({
      grep: ["Omo-Writer: memory-tool", `Omo-Session: ${state.commitSessionId}`],
      limit: NUDGE_SCAN_LIMIT,
      timeoutMs: NUDGE_GIT_TIMEOUT_MS,
      ...(previous !== undefined ? { range: `${previous.head}..${head}` } : { since: new Date(state.startedAt.getTime() - SESSION_START_MARGIN_MS) }),
    })
    const save = commits.find(
      (commit) =>
        commit.trailers["Omo-Writer"] === "memory-tool" &&
        commit.trailers["Omo-Session"] === state.commitSessionId &&
        parseTurn(commit.trailers["Omo-Turn"]) !== undefined,
    )
    const savedTurn = save === undefined ? previous?.savedTurn : parseTurn(save.trailers["Omo-Turn"])
    state.saveScan = { head, savedTurn }
    return savedTurn
  }

  const advanceTurn = async (state: SessionMemory): Promise<Turn> => {
    const head = await repo.head()
    const lines: string[] = []
    if (settings.nudge.enabled) {
      const savedTurn = head === null ? undefined : await latestSaveTurn(state, head)
      const turns = state.userTurns - (savedTurn ?? 0)
      if (turns >= settings.nudge.every_user_turns) lines.push(`- ${turns} ${NUDGE_TOKEN}. Save durable facts now, or decide nothing qualifies.`)
    }
    if (state.pin === undefined) {
      state.pin = { revision: head, noticedThrough: head }
    } else if (state.pin.noticedThrough !== head) {
      const changes = await projectedChangesBetween(repo, state.pin.noticedThrough, head, { excludeSessionId: state.commitSessionId })
      state.pin = { ...state.pin, noticedThrough: head }
      if (!isEmptyProjectedChanges(changes)) lines.push(renderProjectedChangesLine(changes, state.pin.revision))
    }
    return { revision: state.pin.revision, ...(lines.length === 0 ? {} : { notice: ["<memory_notice>", ...lines, "</memory_notice>"].join("\n") }) }
  }

  await ctx.session.hook("prompt", (event) => {
    const state = stateFor(event.sessionID)
    if (typeof event.metadata?.source !== "string") state.userTurns += 1
    state.turn = undefined
  })

  await ctx.session.hook("compaction", (event) => {
    const state = sessions.get(event.sessionID)
    if (state === undefined) return
    state.pin = undefined
    state.turn = undefined
  })

  await ctx.session.hook("context", async (event) => {
    const state = stateFor(event.sessionID)
    state.consentExchange = pendingConsentExchange(event.messages)
    state.turn ??= advanceTurn(state).catch((error: unknown) => {
      omoLogger.warn("memory turn state failed; keeping the pinned projection", error)
      return state.pin === undefined ? undefined : { revision: state.pin.revision }
    })
    const turn = await state.turn
    if (turn === undefined) return
    const block = await blockAt(turn.revision).catch((error: unknown) => {
      omoLogger.warn("memory projection failed to compile", error)
      return undefined
    })
    if (block !== undefined) event.system.push({ type: "text", text: block })
    if (turn.notice !== undefined) appendToLastUserMessage(event.messages, turn.notice)
  })

  await registerMemoryTool(ctx, identity, stateFor)
  const memorySkills = (await loadSkills(join(identity.paths.repo, "skills"))).filter((skill) => !takenSkillIds.has(String(skill.id)))
  await registerSkills(ctx, memorySkills)
  return { identity: identity.id, skills: memorySkills.length }
}
