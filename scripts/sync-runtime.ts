import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { BunPlugin } from "bun"

const PROJECT_ROOT = resolve(import.meta.dir, "..")
const RUNTIME_ROOT = join(PROJECT_ROOT, "runtime")
const CORE_MODULE = join(PROJECT_ROOT, "src", "omo", "core.generated.js")
const MEMORY_HOOK_SCRIPT = join(RUNTIME_ROOT, "memory-hook.js")
const DEFAULT_OMO_AI_PLUGIN = join(homedir(), ".bun/install/global/node_modules/omo-ai/plugin")
const DEFAULT_FORK_PACKAGES = join(homedir(), "Projects/omo-fork/oh-my-openagent/packages")
const STAGED_RUNTIMES = ["ast-grep-mcp", "lsp-daemon"] as const

// OpenCode 2 has no recall sidecar, so the compiled memory reminder must not promise <recalled-memory> blocks.
const RECALL_SENTENCE = "Relevant stored memory arrives on its own as <recalled-memory> blocks; there is no recall tool to call. "
const READ_SENTENCE =
  "Nothing recalls stored memory for you here: when a listed note may matter, read it with the `read` tool; `$MEMORY_DIR` is the MEMORY_DIR path in <memory_metadata>. "

const noRecallReminder: BunPlugin = {
  name: "omo-opencode2-no-recall-reminder",
  setup(build) {
    build.onLoad({ filter: /memory-core\/src\/compile\/compile\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text()
      const count = source.split(RECALL_SENTENCE).length - 1
      if (count !== 1) throw new Error(`${path}: expected the recall sentence once, found ${count}; update scripts/sync-runtime.ts`)
      return { contents: source.replace(RECALL_SENTENCE, () => READ_SENTENCE), loader: "ts" }
    })
  },
}

function flagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined) throw new Error(`${flag} needs a directory`)
  return value
}

async function copyRuntimes(omoAiPlugin: string): Promise<string | undefined> {
  await rm(RUNTIME_ROOT, { recursive: true, force: true })
  await mkdir(RUNTIME_ROOT, { recursive: true })
  for (const name of STAGED_RUNTIMES) {
    const source = join(omoAiPlugin, "runtime", name)
    if (!(await Bun.file(join(source, name === "lsp-daemon" ? "dist/cli.js" : "cli.js")).exists())) {
      throw new Error(`${source} has no built runtime; install or update omo-ai, or pass --omo-ai <plugin dir>`)
    }
    await cp(source, join(RUNTIME_ROOT, name), { recursive: true })
  }
  const manifest = Bun.file(join(omoAiPlugin, "..", "package.json"))
  const version = (await manifest.exists()) ? ((await manifest.json()) as { version?: string }).version : undefined
  // SYNC.json is committed, so it names the source relative to HOME instead of this machine's absolute path.
  const source = omoAiPlugin.startsWith(homedir()) ? `~${omoAiPlugin.slice(homedir().length)}` : omoAiPlugin
  await Bun.write(join(RUNTIME_ROOT, "SYNC.json"), JSON.stringify({ source, omoAiVersion: version, runtimes: STAGED_RUNTIMES }, null, 2) + "\n")
  return version
}

async function bundleCore(forkPackages: string): Promise<void> {
  const commentChecker = join(forkPackages, "omo-senpi/src/components/comment-checker")
  const memoryCore = join(forkPackages, "memory-core/src/index.ts")
  const workDir = await mkdtemp(join(tmpdir(), "omo-opencode2-core-"))
  try {
    const entry = join(workDir, "entry.ts")
    const from = (path: string): string => JSON.stringify(path)
    await Bun.write(
      entry,
      [
        `export { loadOmoConfig } from ${from(join(forkPackages, "omo-config-core/src/index.ts"))}`,
        `export { resolveSenpiCommentCheckerBinary } from ${from(join(commentChecker, "resolver.ts"))}`,
        `export { downloadSenpiCommentCheckerBinary } from ${from(join(commentChecker, "downloader.ts"))}`,
        `export { defaultRunCommentChecker } from ${from(join(commentChecker, "runner.ts"))}`,
        `export { COMMENT_CHECKER_FEEDBACK_HEADER } from ${from(join(commentChecker, "constants.ts"))}`,
        `export { extractApplyPatchEdits } from ${from(join(forkPackages, "comment-checker-core/src/index.ts"))}`,
        `export { collectPostEditDiagnostics, createPostEditNotConfiguredCache, resetPostEditNotConfiguredCache, classifyPostEditFileLocation } from ${from(join(forkPackages, "lsp-core/src/post-edit/index.ts"))}`,
        `export { postEditOutcomeFromDaemonResult } from ${from(join(forkPackages, "omo-senpi/src/components/lsp/post-edit-outcome.ts"))}`,
        `export { getWorkForSession, resolveBoulderPlanPathForWork, getPlanChecklist } from ${from(join(forkPackages, "boulder-state/src/index.ts"))}`,
        `export { OmoMemorySettingsSchema } from ${from(join(forkPackages, "omo-config-core/src/index.ts"))}`,
        `export { resolveAutoIdentity, resolveMemoryIdentity, isAutoAgentValue, GitMemoryRepo, compileMemoryBlockAtRevision, markMemoryBlock, runMemoryTool, MemoryToolError, withLock, createLockRecord, memoryWriterLockPath, buildDefaultSeedFiles, installHooks, resolveClaimReceipt, projectedChangesBetween, isEmptyProjectedChanges, USER_QUOTE_RULE } from ${from(memoryCore)}`,
        `export { renderProjectedChangesLine } from ${from(join(forkPackages, "omo-senpi/src/components/memory/projection-pin.ts"))}`,
        `export { MEMORY_TOOL_DESCRIPTION } from ${from(join(forkPackages, "omo-senpi/src/components/memory/tool-metadata.ts"))}`,
        "",
      ].join("\n"),
    )
    const header =
      "// Generated by scripts/sync-runtime.ts from oh-my-openagent (omo-config-core, comment-checker, lsp-core, boulder-state, memory-core, omo-senpi).\n"
    await Bun.write(CORE_MODULE, header + (await buildOne(entry, [noRecallReminder], "omo core")))
    // The memory repo's git hooks run this checker through OpenCode's own Bun (`BUN_BE_BUN=1 <execPath> <script>`).
    await Bun.write(MEMORY_HOOK_SCRIPT, header + (await buildOne(join(forkPackages, "memory-core/src/memfs/memory-hook-cli.ts"), [], "memory hook")))
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

async function buildOne(entry: string, plugins: BunPlugin[], label: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm", plugins })
  if (!result.success) throw new Error(`bundling ${label} failed:\n${result.logs.map(String).join("\n")}`)
  const output = result.outputs[0]
  if (output === undefined) throw new Error(`bundling ${label} produced no output`)
  return output.text()
}

async function main(): Promise<void> {
  const omoAiPlugin = resolve(flagValue("--omo-ai") ?? process.env.OMO_AI_PLUGIN_DIR ?? DEFAULT_OMO_AI_PLUGIN)
  const forkPackages = resolve(flagValue("--fork") ?? process.env.OMO_FORK_PACKAGES ?? DEFAULT_FORK_PACKAGES)
  const version = await copyRuntimes(omoAiPlugin)
  await bundleCore(forkPackages)
  console.log(`staged ${STAGED_RUNTIMES.join(", ")} from omo-ai ${version ?? "(unknown version)"} into ${RUNTIME_ROOT}; bundled ${CORE_MODULE} and ${MEMORY_HOOK_SCRIPT}`)
}

await main()
