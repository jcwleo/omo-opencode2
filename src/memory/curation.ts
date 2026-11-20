import { existsSync, realpathSync, statSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import type { Message } from "@opencode/ai"
import { Agent, type Plugin } from "@opencode/plugin"
import type { GitMemoryRepo, MemoryIdentity, OmoMemoryDreamSettings, OmoMemoryReflectionSettings, OmoMemorySettings } from "../omo/core.generated.js"
import { isRecord, omoLogger } from "../omo/shared.ts"
import { MEMORY_TOOL_NAME, type MemoryWriteRefusal } from "./tool.ts"

const PERSONAS_ROOT = fileURLToPath(new URL("./personas/", import.meta.url))
export const REFLECTION_AGENT_ID = "omo-memory-reflection"
export const DREAM_AGENT_ID = "omo-memory-dream"
export const CURATION_SOURCE = "omo-memory-curation"
const DREAM_STATE_FILE = "opencode2-dream.json"
const PROTECTED_PATHS: ReadonlySet<string> = new Set(["system/boundaries.md", "system/agreements.md"])
// omo's recall event caps, and a total that keeps the newest part of a long session.
const DIGEST_CAPS = { user: 4000, assistant: 1500, toolArgs: 400, toolResult: 600, total: 60_000 }
const DREAM_COMMIT_LIMIT = 50

type Kind = "reflection" | "dream"
type Job = { readonly kind: Kind; readonly parentID: string; readonly prompt: string; readonly done?: () => Promise<void> }
type RootState = { steps: number; messages?: readonly Message[]; readonly local: Promise<boolean>; readonly root: Promise<boolean> }
type ModelRef = { readonly id: string; readonly providerID: string; readonly variant?: string }
type DreamState = { readonly lastDreamAt?: string; readonly lastHead?: string }

export interface CurationOptions {
  readonly reflection: boolean
  readonly dream: boolean
}

export interface Curation {
  readonly lanes: readonly Kind[]
  readonly refusal: MemoryWriteRefusal
  readonly stop: () => void
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

export function digestConversation(messages: readonly Message[]): { readonly text: string; readonly omitted: number } {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role === "system") continue
    for (const part of message.content) {
      if (part.type === "text") {
        const text = part.text.trim()
        if (text === "") continue
        if (message.role === "user") lines.push(`[user] ${clip(text, DIGEST_CAPS.user)}`)
        else if (message.role === "assistant") lines.push(`[assistant] ${clip(text, DIGEST_CAPS.assistant)}`)
        else lines.push(`[${message.role}] ${clip(text, DIGEST_CAPS.toolResult)}`)
      } else if (part.type === "tool-call") {
        lines.push(`[tool call] ${part.name} ${clip(valueText(part.input), DIGEST_CAPS.toolArgs)}`)
      } else if (part.type === "tool-result") {
        lines.push(`[tool result] ${part.name}: ${clip(valueText(part.result.value), DIGEST_CAPS.toolResult)}`)
      }
    }
  }
  let size = 0
  let start = lines.length
  while (start > 0) {
    const line = lines[start - 1] ?? ""
    if (size + line.length + 1 > DIGEST_CAPS.total) break
    size += line.length + 1
    start -= 1
  }
  return { text: lines.slice(start).join("\n"), omitted: start }
}

function repoRelative(repoDir: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined
  return (isAbsolute(value) ? relative(repoDir, value) : value).replace(/^\.\//, "")
}

function skillName(path: string): string | undefined {
  return /^skills\/([^/]+)\//.exec(path)?.[1]
}

function patchTargets(input: unknown): { readonly added: string[]; readonly updated: string[]; readonly deleted: string[] } {
  const targets = { added: [] as string[], updated: [] as string[], deleted: [] as string[] }
  if (typeof input !== "string") return targets
  for (const line of input.split(/\r?\n/)) {
    const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    const moved = /^\*\*\* Move to: (.+)$/.exec(line)
    if (file?.[1] === "Add" && file[2] !== undefined) targets.added.push(file[2].trim())
    else if (file?.[1] === "Update" && file[2] !== undefined) targets.updated.push(file[2].trim())
    else if (file?.[1] === "Delete" && file[2] !== undefined) targets.deleted.push(file[2].trim())
    else if (moved?.[1] !== undefined) targets.added.push(moved[1].trim())
  }
  return targets
}

// Unattended runs may edit and move memory, never delete it, add a skill, retire one, or touch the user's own files.
export function unattendedRefusal(repoDir: string, params: Readonly<Record<string, unknown>>): string | undefined {
  const deleteRefusal = "unattended memory runs never delete; move the content to reference/ or summarize it into ARCHIVE.md instead"
  const path = (value: unknown) => repoRelative(repoDir, value)
  const writes: string[] = []
  const created: string[] = []
  switch (params.command) {
    case "delete":
      return deleteRefusal
    case "create": {
      const target = path(params.file_path)
      if (target !== undefined) {
        writes.push(target)
        created.push(target)
      }
      break
    }
    case "str_replace":
    case "insert":
    case "update_description": {
      const target = path(params.file_path)
      if (target !== undefined) writes.push(target)
      break
    }
    case "rename": {
      const from = path(params.old_path)
      const to = path(params.new_path)
      if (from !== undefined) writes.push(from)
      if (to !== undefined) {
        writes.push(to)
        created.push(to)
      }
      const fromSkill = from === undefined ? undefined : skillName(from)
      if (fromSkill !== undefined && (to === undefined || skillName(to) !== fromSkill)) return `unattended memory runs never retire a skill (${from}); report it as a candidate instead`
      break
    }
    case "apply_patch": {
      const targets = patchTargets(params.input)
      if (targets.deleted.length > 0) return deleteRefusal
      writes.push(...targets.added, ...targets.updated)
      created.push(...targets.added)
      break
    }
  }
  const touched = writes.find((target) => PROTECTED_PATHS.has(target))
  if (touched !== undefined) return `unattended memory runs leave ${touched} to the user`
  const skill = created.find((target) => {
    const name = skillName(target)
    return name !== undefined && !existsSync(join(repoDir, "skills", name, "SKILL.md"))
  })
  if (skill !== undefined) return `unattended memory runs never add a new skill (${skill}); update or extend an existing skill, or report it as a skill candidate`
  return undefined
}

function reflectionSettings(settings: OmoMemorySettings, agentId: string): OmoMemoryReflectionSettings {
  const override = settings.agents[agentId]?.reflection
  return { ...settings.reflection, ...override, trigger: { ...settings.reflection.trigger, ...override?.trigger } }
}

function dreamSettings(settings: OmoMemorySettings, agentId: string): OmoMemoryDreamSettings {
  return { ...settings.dream, ...settings.agents[agentId]?.dream }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function reflectionPrompt(trigger: "steps" | "compaction", digest: { readonly text: string; readonly omitted: number }): string {
  return [
    `<omo-memory-reflection trigger="${trigger}" date="${today()}">`,
    "Review this excerpt of the parent session and update memory following your instructions.",
    digest.omitted > 0 ? `<conversation omitted-earlier-lines="${digest.omitted}">` : "<conversation>",
    digest.text,
    "</conversation>",
    "</omo-memory-reflection>",
  ].join("\n")
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

async function readDreamState(path: string): Promise<DreamState> {
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (raw === undefined) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) return {}
  return {
    ...(typeof parsed.lastDreamAt === "string" ? { lastDreamAt: parsed.lastDreamAt } : {}),
    ...(typeof parsed.lastHead === "string" ? { lastHead: parsed.lastHead } : {}),
  }
}

export async function registerCuration(
  ctx: Plugin.Context,
  identity: MemoryIdentity,
  repo: GitMemoryRepo,
  settings: OmoMemorySettings,
  options: CurationOptions,
): Promise<Curation> {
  const repoDir = identity.paths.repo
  const reflection = reflectionSettings(settings, identity.id)
  const dream = dreamSettings(settings, identity.id)
  const budget = settings.agents[identity.id]?.compile_warn_tokens ?? settings.compile_warn_tokens
  const lanes: Kind[] = [...(options.reflection && reflection.enabled ? (["reflection"] as const) : []), ...(options.dream && dream.enabled ? (["dream"] as const) : [])]
  const curatorSessions = new Set<string>()
  const refusal: MemoryWriteRefusal = (sessionID, params) => (curatorSessions.has(sessionID) ? unattendedRefusal(repoDir, params) : undefined)
  if (lanes.length === 0) return { lanes, refusal, stop: () => undefined }

  const agentIds: Record<Kind, string> = { reflection: REFLECTION_AGENT_ID, dream: DREAM_AGENT_ID }
  const curatorAgents: ReadonlySet<string> = new Set(lanes.map((kind) => agentIds[kind]))
  const personas = Object.fromEntries(await Promise.all(lanes.map(async (kind) => [kind, await readFile(join(PERSONAS_ROOT, `${kind}.md`), "utf8")] as const)))
  // The repo lies outside the project, and OpenCode checks external paths in their canonical form.
  const repoDirs = [...new Set([repoDir, canonicalPath(repoDir)])]
  const rules = [
    { action: "*", resource: "*", effect: "deny" as const },
    { action: MEMORY_TOOL_NAME, resource: "*", effect: "allow" as const },
    ...repoDirs.flatMap((dir) => [
      { action: "external_directory", resource: `${dir}/*`, effect: "allow" as const },
      { action: "read", resource: `${dir}/*`, effect: "allow" as const },
    ]),
  ]
  await ctx.agent.transform((editor) => {
    for (const kind of lanes) {
      editor.update(agentIds[kind], (agent) => {
        agent.name = Agent.Name.make(kind === "reflection" ? "Memory reflection" : "Memory dream")
        agent.description = `Background memory ${kind} run by omo-opencode2`
        agent.mode = "primary"
        agent.hidden = true
        agent.system = personas[kind]
        agent.permissions = [...agent.permissions, ...rules]
      })
    }
  })

  const curatorModel = async (parentID: string): Promise<ModelRef | undefined> => {
    const category = await ctx.agent.get({ agentID: `omo/${reflection.category}` }).then(
      (result) => result.data.model,
      () => undefined,
    )
    if (category !== undefined) return { id: String(category.id), providerID: String(category.providerID), ...(category.variant === undefined ? {} : { variant: String(category.variant) }) }
    return (await ctx.session.get({ sessionID: parentID })).model
  }

  const runOnce = async (job: Job): Promise<void> => {
    const model = await curatorModel(job.parentID)
    // No parentID: OpenCode posts a finished child's last reply into its parent and runs a new parent turn.
    const session = await ctx.session.create({
      title: `memory ${job.kind}`,
      agent: agentIds[job.kind],
      ...(model === undefined ? {} : { model }),
      metadata: { source: CURATION_SOURCE, kind: job.kind },
    })
    curatorSessions.add(session.id)
    try {
      await ctx.session.prompt({ sessionID: session.id, text: job.prompt, metadata: { source: CURATION_SOURCE } })
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), reflection.timeout_minutes * 60_000)
      })
      const expired = await Promise.race([ctx.session.wait({ sessionID: session.id }).then(() => false as const), timedOut])
      clearTimeout(timer)
      if (expired) {
        omoLogger.warn(`memory ${job.kind} run ${session.id} passed ${reflection.timeout_minutes} minutes; interrupting it`)
        await ctx.session.interrupt({ sessionID: session.id })
      }
    } finally {
      // A root session would pile up in the session list, and OpenCode un-archives a session when its run settles.
      await ctx.session.remove({ sessionID: session.id }).catch((error: unknown) => omoLogger.warn(`memory ${job.kind} could not remove ${session.id}`, error))
    }
    await job.done?.()
  }

  let running = false
  let pending: Job | undefined
  const enqueue = (job: Job): void => {
    if (running) {
      pending = job
      return
    }
    running = true
    void runOnce(job)
      .catch((error: unknown) => omoLogger.warn(`memory ${job.kind} run failed`, error))
      .finally(() => {
        running = false
        const next = pending
        pending = undefined
        if (next !== undefined) enqueue(next)
      })
  }

  const roots = new Map<string, RootState>()
  const here = canonicalPath(ctx.location.directory)
  const rootState = (sessionID: string): RootState => {
    const existing = roots.get(sessionID)
    if (existing !== undefined) return existing
    const session = ctx.session.get({ sessionID }).then(
      (info) => (canonicalPath(info.location.directory) === here ? info : undefined),
      () => undefined,
    )
    const created: RootState = {
      steps: 0,
      local: session.then((info) => info !== undefined),
      root: session.then((info) => info !== undefined && info.parentID === undefined),
    }
    roots.set(sessionID, created)
    return created
  }

  const reflect = (sessionID: string, messages: readonly Message[], trigger: "steps" | "compaction"): void => {
    const digest = digestConversation(messages)
    if (digest.text === "") return
    enqueue({ kind: "reflection", parentID: sessionID, prompt: reflectionPrompt(trigger, digest) })
  }

  const reflectionOn = lanes.includes("reflection")
  await ctx.session.hook("context", async (event) => {
    if (curatorAgents.has(event.agent) || curatorSessions.has(event.sessionID)) {
      // OpenCode keeps the skill tool listed for agents that deny every skill (see agents/index.ts).
      delete event.tools.skill
      return
    }
    if (!reflectionOn) return
    const state = rootState(event.sessionID)
    if (!(await state.root)) return
    state.steps += 1
    state.messages = event.messages
  })

  if (reflectionOn && reflection.trigger.on_compaction) {
    await ctx.session.hook("compaction", async (event) => {
      if (curatorSessions.has(event.sessionID)) return
      const state = rootState(event.sessionID)
      if (!(await state.root)) return
      state.steps = 0
      reflect(event.sessionID, event.messages, "compaction")
    })
  }

  const reflectAfterSteps = async (sessionID: string): Promise<void> => {
    const state = roots.get(sessionID)
    if (state === undefined || !(await state.root)) return
    const limit = reflection.trigger.step_count
    if (limit <= 0 || state.steps < limit || state.messages === undefined) return
    state.steps = 0
    reflect(sessionID, state.messages, "steps")
  }

  const dreamStatePath = join(identity.paths.runtime, DREAM_STATE_FILE)
  const writeDreamState = async (state: DreamState): Promise<void> => {
    await mkdir(identity.paths.runtime, { recursive: true })
    await writeFile(dreamStatePath, `${JSON.stringify(state)}\n`)
  }

  const dreamPrompt = async (sinceHead: string | undefined): Promise<string> => {
    const files = await repo.lsTree("HEAD")
    const systemBytes = files.filter((path) => path.startsWith("system/") && path.endsWith(".md")).reduce((sum, path) => sum + fileSize(join(repoDir, path)), 0)
    const commits = await (sinceHead === undefined ? repo.log({ limit: DREAM_COMMIT_LIMIT }) : repo.log({ range: `${sinceHead}..HEAD`, limit: DREAM_COMMIT_LIMIT }).catch(() => repo.log({ limit: DREAM_COMMIT_LIMIT })))
    return [
      `<omo-memory-dream date="${today()}">`,
      `system/ estimate: about ${Math.ceil(systemBytes / 4)} tokens (budget ${budget}, target ${Math.floor(budget * 0.8)}).`,
      "",
      "Files (path, bytes):",
      ...files.map((path) => `- ${path} ${fileSize(join(repoDir, path))}`),
      "",
      sinceHead === undefined ? "Recent commits, newest first (first dream):" : "Commits since the last dream, newest first:",
      ...commits.map((commit) => `- ${commit.committedAt.slice(0, 10)} ${commit.subject}`),
      "</omo-memory-dream>",
    ].join("\n")
  }

  const maybeDream = async (parentID: string): Promise<void> => {
    if (active.size > 0) return
    const state = await readDreamState(dreamStatePath)
    const now = Date.now()
    if (state.lastDreamAt !== undefined && now - Date.parse(state.lastDreamAt) < dream.min_hours_between * 3_600_000) return
    const head = await repo.head()
    if (head === null || head === state.lastHead) return
    const startedAt = new Date(now).toISOString()
    await writeDreamState({ lastDreamAt: startedAt, lastHead: head })
    enqueue({
      kind: "dream",
      parentID,
      prompt: await dreamPrompt(state.lastHead),
      done: async () => writeDreamState({ lastDreamAt: startedAt, lastHead: (await repo.head()) ?? head }),
    })
  }

  const active = new Set<string>()
  let dreamTimer: ReturnType<typeof setTimeout> | undefined
  const armDream = async (sessionID: string): Promise<void> => {
    clearTimeout(dreamTimer)
    if (active.size > 0 || !(await rootState(sessionID).root)) return
    dreamTimer = setTimeout(() => {
      void maybeDream(sessionID).catch((error: unknown) => omoLogger.warn("memory dream gate failed", error))
    }, dream.idle_minutes * 60_000)
  }

  const dreamOn = lanes.includes("dream")
  const controller = new AbortController()
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (
        event.type !== "session.execution.started" &&
        event.type !== "session.execution.succeeded" &&
        event.type !== "session.execution.failed" &&
        event.type !== "session.execution.interrupted"
      )
        continue
      const sessionID = String(event.data.sessionID)
      if (curatorSessions.has(sessionID)) continue
      // The event stream spans every directory on the server; another directory's sessions belong to that
      // directory's plugin instance and must neither start nor hold back this repo's dream.
      if (!(await rootState(sessionID).local)) continue
      if (event.type === "session.execution.started") {
        active.add(sessionID)
        clearTimeout(dreamTimer)
        continue
      }
      active.delete(sessionID)
      if (event.type === "session.execution.succeeded" && reflectionOn) await reflectAfterSteps(sessionID)
      if (dreamOn) await armDream(sessionID)
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) omoLogger.warn("memory curation subscription stopped", error)
  })

  return {
    lanes,
    refusal,
    stop: () => {
      controller.abort()
      clearTimeout(dreamTimer)
    },
  }
}
