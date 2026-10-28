import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import {
  buildDefaultSeedFiles,
  createLockRecord,
  GitMemoryRepo,
  installHooks,
  MEMORY_TOOL_DESCRIPTION,
  memoryWriterLockPath,
  MemoryToolError,
  resolveClaimReceipt,
  runMemoryTool,
  USER_QUOTE_RULE,
  withLock,
  type MemoryIdentity,
  type MemoryToolLock,
} from "../omo/core.generated.js"
import { isRecord, RUNTIME_ROOT } from "../omo/shared.ts"

export const MEMORY_TOOL_NAME = "memory"
const MEMORY_HOOK_SCRIPT = join(RUNTIME_ROOT, "memory-hook.js")
const LOCK_WAIT_MS = 5_000

// omo-senpi's promptGuidelines for the memory tool; OpenCode has no guideline slot, so they ride on the description.
const MEMORY_TOOL_GUIDELINES = [
  "Record durable facts, preferences, and decisions with the memory tool as you learn them; every change is committed with the reason you provide.",
  "Pass source on every write. Record a user decision only as source user with one whole user message, verbatim, in user_quote; your own recommendations are source agent, never 'the user agreed'.",
  "Memory files are markdown with YAML frontmatter; keep each block's description accurate because the memory index surfaces it.",
  "When creating, renaming, or deleting memory files, update [[path]] references in other memory files so they stay discoverable.",
]

const text = (description: string) => ({ type: "string", description })

const MEMORY_TOOL_INPUT = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["create", "str_replace", "insert", "delete", "rename", "update_description", "apply_patch"],
      description: "The memory operation to perform.",
    },
    reason: text("Git commit message recorded for this memory change."),
    file_path: text("Target memory file: relative to the memory repo, or absolute inside it. Required by create, str_replace, insert, delete, and update_description."),
    old_path: text("Current path of the memory file. Required by rename."),
    new_path: text("Destination path of the memory file. Required by rename."),
    old_string: text("Exact text to replace. Required by str_replace."),
    new_string: text("Replacement text. Required by str_replace."),
    insert_line: { type: "number", description: "1-based line number at which to insert text. Required by insert." },
    insert_text: text("Text to insert. Required by insert."),
    description: text("Frontmatter description of the memory block. Required by create and update_description."),
    file_text: text("Initial body text for create."),
    input: text("Codex-style patch text for apply_patch."),
    source: {
      type: "string",
      enum: ["user", "agent", "inferred"],
      description:
        "Who the saved content came from: user (the user said it), agent (your own suggestion or statement), inferred (your conclusion). Omitted means inferred. Saved as the note's provenance receipt.",
    },
    user_quote: text(USER_QUOTE_RULE),
  },
  required: ["command", "reason"],
  additionalProperties: false,
} as const

export interface MemoryToolSession {
  readonly commitSessionId: string
  readonly userTurns: number
  readonly consentExchange: readonly { readonly proposal: string; readonly reply: string }[]
}

export async function prepareMemoryEngine(identity: MemoryIdentity): Promise<{ repo: GitMemoryRepo; lock: MemoryToolLock }> {
  await mkdir(identity.paths.locks, { recursive: true, mode: 0o700 })
  const repo = new GitMemoryRepo({ dir: identity.paths.repo, agentId: identity.id })
  const lock: MemoryToolLock = async (domain, operation) => {
    if (domain !== "memory-write") throw new MemoryToolError(`unsupported lock domain '${domain}'`)
    const record = await createLockRecord(`memory tool (${identity.id})`)
    return withLock(memoryWriterLockPath(identity.paths.locks), record, operation, { waitTimeoutMs: LOCK_WAIT_MS })
  }
  if (!existsSync(join(identity.paths.repo, ".git"))) {
    await lock("memory-write", async () => {
      if (existsSync(join(identity.paths.repo, ".git"))) return
      await repo.init({
        seedFiles: buildDefaultSeedFiles(),
        installHooks: (dir) => {
          installHooks(dir, { checker: { execPath: process.execPath, script: MEMORY_HOOK_SCRIPT } })
        },
      })
    })
  }
  return { repo, lock }
}

export async function registerMemoryTool(
  ctx: Plugin.Context,
  identity: MemoryIdentity,
  sessionFor: (sessionID: string) => MemoryToolSession,
): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: MEMORY_TOOL_NAME,
      description: [MEMORY_TOOL_DESCRIPTION, "", ...MEMORY_TOOL_GUIDELINES.map((line) => `- ${line}`)].join("\n"),
      input: MEMORY_TOOL_INPUT,
      options: { codemode: false },
      execute: async (input, context) => {
        const params = isRecord(input) ? input : {}
        const session = sessionFor(context.sessionID)
        const { repo, lock } = await prepareMemoryEngine(identity)
        // Model-supplied author/provenance never reach the commit: the session's own values replace them.
        const claim = resolveClaimReceipt({ source: params.source, userQuote: params.user_quote }, session.consentExchange)
        const result = await runMemoryTool({
          repo,
          lock,
          params: {
            ...params,
            command: String(params.command),
            reason: typeof params.reason === "string" ? params.reason : "",
            author: { agentId: identity.id, authorName: identity.id },
            provenance: { sessionId: session.commitSessionId, userTurns: session.userTurns, claim },
          },
        })
        return { content: result.message, metadata: result.commit === undefined ? {} : { sha: result.commit.sha, paths: result.commit.affectedPaths } }
      },
    })
  })
}
