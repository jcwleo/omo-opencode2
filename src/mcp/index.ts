import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { RUNTIME_ROOT } from "../omo/shared.ts"

type ServerConfig = Parameters<Parameters<Plugin.Context["mcp"]["transform"]>[0]>[0] extends { set(name: string, config: infer Config): void } ? Config : never

const CONTEXT7_API_KEY_ENV = "CONTEXT7_API_KEY"

// Copied `.env` templates carry `<YOUR_API_KEY>`-style values; sending one as a bearer token turns the
// anonymous-but-working context7 server into an authentication failure (same rule as omo-senpi builtin-mcps).
function context7ApiKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase().replace(/[<>"'`]/g, "").replace(/[\s_-]+/g, " ")
  return normalized.length > 0 && normalized !== "your api key" ? value.trim() : undefined
}

// The staged runtimes are Bun/Node scripts; BUN_BE_BUN lets the bun-compiled OpenCode binary run them.
function stagedScript(directory: string, script: string, env: Record<string, string>): ServerConfig {
  return { type: "local", command: [process.execPath, join(RUNTIME_ROOT, script), "mcp"], cwd: directory, environment: { BUN_BE_BUN: "1", ...env } }
}

export function builtinMcpServers(directory: string, env: Record<string, string | undefined> = process.env): ReadonlyMap<string, ServerConfig> {
  const key = context7ApiKey(env[CONTEXT7_API_KEY_ENV])
  return new Map<string, ServerConfig>([
    ["context7", { type: "remote", url: "https://mcp.context7.com/mcp", oauth: false, codemode: true, ...(key === undefined ? {} : { headers: { Authorization: `Bearer ${key}` } }) }],
    ["grep_app", { type: "remote", url: "https://mcp.grep.app", oauth: false, codemode: true }],
    ["ast_grep", { ...stagedScript(directory, "ast-grep-mcp/cli.js", { OMO_AST_GREP_PROJECT_CWD: directory }), codemode: true }],
    ["lsp", { ...stagedScript(directory, "lsp-daemon/dist/cli.js", {}), codemode: false }],
  ])
}

export async function registerBuiltinMcps(ctx: Plugin.Context): Promise<string[]> {
  const servers = builtinMcpServers(ctx.location.directory)
  await ctx.mcp.transform((editor) => {
    for (const [name, config] of servers) {
      if (editor.get(name) === undefined) editor.set(name, config)
    }
  })
  return [...servers.keys()]
}
