import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin } from "@opencode/plugin"
import {
  classifyPostEditFileLocation,
  collectPostEditDiagnostics,
  createPostEditNotConfiguredCache,
  postEditOutcomeFromDaemonResult,
  resetPostEditNotConfiguredCache,
  type PostEditNotConfiguredCache,
} from "../omo/core.generated.js"
import { appendToolText, isRecord, RUNTIME_ROOT } from "../omo/shared.ts"
import { MUTATION_TOOLS, mutatedFilePaths } from "./mutated-files.ts"

type DaemonResult = { readonly content: readonly { readonly type: string; readonly text?: string }[]; readonly details?: unknown }
type DaemonClient = { callToolViaDaemon(name: string, args: Record<string, unknown>, options: { context: Record<string, unknown> }): Promise<DaemonResult> }

// The daemon resolves language servers from omo's LSP config files, the same paths omo-senpi passes.
const CONFIG_DIRS = [".omo", ".pi"] as const

function firstExistingOrBranded(root: string, file: string): string {
  const candidates = CONFIG_DIRS.map((dir) => join(root, dir, file))
  return candidates.find((path) => existsSync(path)) ?? join(root, CONFIG_DIRS[0], file)
}

function requestContext(directory: string): Record<string, unknown> {
  const cwd = existsSync(directory) ? realpathSync(directory) : resolve(directory)
  const home = resolve(process.env.HOME?.trim() || homedir())
  return {
    cwd,
    projectConfigPaths: CONFIG_DIRS.map((dir) => join(cwd, dir, "lsp-client.json")),
    userConfigPath: firstExistingOrBranded(home, "lsp-client.json"),
    installDecisionsPath: firstExistingOrBranded(home, "lsp-install-decisions.json"),
    capabilities: { installDecisionTool: false },
  }
}

function loadDaemonClient(): Promise<DaemonClient> {
  return import(pathToFileURL(join(RUNTIME_ROOT, "lsp-daemon/dist/client.js")).href).then((module: unknown) => {
    if (!isRecord(module) || typeof module.callToolViaDaemon !== "function") throw new Error("staged lsp-daemon has no callToolViaDaemon export; run `bun run sync:runtime`")
    return module as DaemonClient
  })
}

export async function registerLspDiagnostics(ctx: Plugin.Context): Promise<void> {
  const directory = ctx.location.directory
  const caches = new Map<string, PostEditNotConfiguredCache>()
  let client: Promise<DaemonClient> | undefined

  await ctx.session.hook("compaction", (event) => {
    const cache = caches.get(event.sessionID)
    if (cache !== undefined) resetPostEditNotConfiguredCache(cache)
  })

  await ctx.tool.hook("execute.after", async (event) => {
    if (event.status !== "completed" || !MUTATION_TOOLS.has(event.tool)) return
    const filePaths = mutatedFilePaths(event.tool, event.input, event.result.metadata, directory)
    if (filePaths.length === 0) return
    const cache = caches.get(event.sessionID) ?? createPostEditNotConfiguredCache()
    caches.set(event.sessionID, cache)
    client ??= loadDaemonClient()
    const daemon = await client
    const result = await collectPostEditDiagnostics({
      filePaths,
      cache,
      maxConcurrency: 4,
      locateFile: (filePath) => classifyPostEditFileLocation(filePath, { cwd: directory, agentDirs: [] }),
      runDiagnostics: async (filePath) =>
        postEditOutcomeFromDaemonResult(await daemon.callToolViaDaemon("diagnostics", { filePath, severity: "error" }, { context: requestContext(directory) })),
    })
    if (result.blocks.length === 0) return
    const text = result.blocks.map((block) => `LSP errors detected in ${block.filePath}, please fix:\n${block.diagnostics}`).join("\n\n")
    event.result = { ...event.result, content: appendToolText(event.result.content, text) }
  })
}
