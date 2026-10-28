import { Database } from "bun:sqlite"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { Subprocess } from "bun"
import { resolveAutoIdentity, resolveSenpiCommentCheckerBinary, runMemoryTool, type MemoryIdentity } from "../../src/omo/core.generated.js"
import { prepareMemoryEngine } from "../../src/memory/tool.ts"

export const PLUGIN_ROOT = resolve(import.meta.dir, "../..")
export const GLM = "opencode/glm-5.3-flash-free"
const PASSWORD = "omo-e2e"
const REAL_DB = join(homedir(), ".local/share/opencode/opencode.db")
const REAL_MEMORY_AGENTS = join(homedir(), ".omo/memory/agents")

export type ChatPart = { readonly type: string; readonly text?: string }
export type ToolCall = { readonly id: string; readonly function: { readonly name: string; readonly arguments: string } }
export type ChatMessage = {
  readonly role: string
  readonly content?: string | readonly ChatPart[] | null
  readonly tool_calls?: readonly ToolCall[]
  readonly tool_call_id?: string
}
export type ChatBody = { readonly model: string; readonly messages: readonly ChatMessage[]; readonly tools?: readonly { readonly function: { readonly name: string; readonly description?: string } }[] }
export type ProbeRequest = {
  readonly kind: "request"
  readonly at: number
  readonly sessionID: string
  readonly agent: string
  readonly requestKind: string
  readonly model: string
  readonly body: string
  readonly transport?: "ws"
}
export type ProbeEvent = { readonly kind: "event"; readonly at: number; readonly type: string; readonly sessionID?: string }
export type ProbeCall = { readonly kind: "ws-call"; readonly sessionID: string; readonly callID: string; readonly name: string; readonly arguments: string }
export type ProbeEntry = ProbeRequest | ProbeEvent | ProbeCall | { readonly kind: "probe-error"; readonly sessionID: string; readonly error: string }

type ResponsesContent = string | readonly { readonly type: string; readonly text?: string }[] | undefined
type ResponsesItem = { readonly type: string; readonly role?: string; readonly content?: ResponsesContent; readonly call_id?: string; readonly name?: string; readonly arguments?: string; readonly output?: ResponsesContent }
type ResponsesFrame = { readonly type?: "response.create"; readonly model: string; readonly instructions?: string; readonly input?: readonly ResponsesItem[]; readonly tools?: readonly { readonly name: string; readonly description?: string }[] }

function responsesParts(content: ResponsesContent): string | ChatPart[] {
  if (content === undefined) return ""
  if (typeof content === "string") return content
  return content.filter((part) => typeof part.text === "string").map((part) => ({ type: "text", text: part.text }))
}

function fromResponses(frame: ResponsesFrame): ChatBody {
  const messages: ChatMessage[] = frame.instructions === undefined ? [] : [{ role: "system", content: frame.instructions }]
  for (const item of frame.input ?? []) {
    if (item.type === "message") messages.push({ role: item.role === "developer" ? "system" : (item.role ?? "user"), content: responsesParts(item.content) })
    else if (item.type === "function_call" && item.call_id !== undefined) messages.push({ role: "assistant", content: "", tool_calls: [{ id: item.call_id, function: { name: item.name ?? "", arguments: item.arguments ?? "{}" } }] })
    else if (item.type === "function_call_output" && item.call_id !== undefined) messages.push({ role: "tool", tool_call_id: item.call_id, content: responsesParts(item.output) })
  }
  return { model: frame.model, messages, tools: (frame.tools ?? []).map((tool) => ({ function: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }) } })) }
}

// Chat-completions providers send `messages`; the OpenAI Responses API sends `input`, over HTTP as a request body and
// over the ChatGPT WebSocket as `response.create` frames.
export function parseRequestBody(body: string): ChatBody {
  const parsed = JSON.parse(body) as ChatBody | ResponsesFrame
  return "messages" in parsed ? parsed : fromResponses(parsed)
}
export type ToolExchange = { readonly name: string; readonly args: Record<string, unknown>; readonly result: string | undefined }

export function textOf(content: ChatMessage["content"]): string {
  if (content === undefined || content === null) return ""
  if (typeof content === "string") return content
  return content.map((part) => part.text ?? "").join("")
}

export function systemText(body: ChatBody): string {
  return body.messages.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n")
}

export function lastUserText(body: ChatBody): string {
  const user = body.messages.findLast((message) => message.role === "user")
  return user === undefined ? "" : textOf(user.content)
}

export function toolNames(body: ChatBody): string[] {
  return (body.tools ?? []).map((tool) => tool.function.name).sort()
}

export function toolExchanges(bodies: readonly ChatBody[]): ToolExchange[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>()
  const results = new Map<string, string>()
  for (const body of bodies) {
    for (const message of body.messages) {
      for (const call of message.tool_calls ?? []) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.function.arguments) as Record<string, unknown>
        } catch {
          args = { unparsed: call.function.arguments }
        }
        calls.set(call.id, { name: call.function.name, args })
      }
      if (message.role === "tool" && message.tool_call_id !== undefined) results.set(message.tool_call_id, textOf(message.content))
    }
  }
  return [...calls].map(([id, call]) => ({ ...call, result: results.get(id) }))
}

export function newSessionID(): string {
  return `ses_${[...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

export function realSessionCount(): number {
  if (!existsSync(REAL_DB)) return 0
  const db = new Database(REAL_DB, { readonly: true })
  try {
    return (db.query("select count(*) as n from session_v2").get() as { n: number }).n
  } finally {
    db.close()
  }
}

export async function waitFor<T>(what: string, check: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await Bun.sleep(250)
  }
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error("no free port")
  return port
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`)
}

export interface SandboxOptions {
  readonly pluginOptions?: Record<string, unknown>
  readonly providers?: Record<string, unknown>
  readonly omoConfig?: Record<string, unknown>
  readonly env?: Record<string, string>
  readonly credentials?: readonly string[]
}

export class Sandbox {
  private server: Subprocess | undefined
  private port = 0
  private extraEnv: Record<string, string> = {}
  private credentials: readonly string[] = []
  private constructor(
    readonly root: string,
    readonly home: string,
    readonly project: string,
    readonly memoryRoot: string,
    readonly probeLog: string,
  ) {}

  static async create(options: SandboxOptions = {}): Promise<Sandbox> {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "omo-oc2-e2e-")))
    const home = join(root, "home")
    const sandbox = new Sandbox(root, home, join(home, "project"), join(root, "memory"), join(root, "probe.jsonl"))
    sandbox.extraEnv = options.env ?? {}
    sandbox.credentials = options.credentials ?? []
    await sandbox.writeFixture(options)
    return sandbox
  }

  private async writeFixture(options: SandboxOptions): Promise<void> {
    const project = this.project
    for (const dir of ["xdg/config", "xdg/data", "xdg/state", "xdg/cache", "memory"]) await mkdir(join(this.root, dir), { recursive: true })
    await mkdir(join(project, "sub"), { recursive: true })
    await mkdir(join(project, "src"), { recursive: true })
    await mkdir(join(project, "node_modules"), { recursive: true })
    await mkdir(join(project, ".omo"), { recursive: true })
    await git(project, "init", "-q")
    const files: Record<string, string> = {
      "AGENTS.md": "ROOT-MARKER: project rules for the e2e fixture.\n",
      "sub/AGENTS.md": "SUB-MARKER: rules that apply only inside sub/.\n",
      "sub/notes.txt": "hello from the notes file\n",
      "package.json": `${JSON.stringify({ name: "omo-oc2-e2e-fixture", private: true, type: "module" }, null, 2)}\n`,
      "tsconfig.json": `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ESNext", module: "ESNext" }, include: ["src"] }, null, 2)}\n`,
      "src/index.ts": "export const answer: number = 42\n",
      ".omo/omo.jsonc": `${JSON.stringify(options.omoConfig ?? {}, null, 2)}\n`,
      "opencode.jsonc": `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugins: [{ package: PLUGIN_ROOT, options: options.pluginOptions ?? {} }, join(PLUGIN_ROOT, "tests/e2e/probe")],
          ...(options.providers === undefined ? {} : { providers: options.providers }),
        },
        null,
        2,
      )}\n`,
    }
    for (const [path, content] of Object.entries(files)) await writeFile(join(project, path), content)
    // typescript-language-server needs tsserver.js, which TypeScript 7 no longer ships; the fixture gets TypeScript 5.
    await symlink(join(PLUGIN_ROOT, "node_modules/typescript-tsserver"), join(project, "node_modules/typescript"))
  }

  env(): Record<string, string> {
    const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("OPENCODE_")))
    const checker = resolveSenpiCommentCheckerBinary()
    return {
      ...inherited,
      // OpenCode resolves a session's models from the location named by PWD, not from the process cwd.
      PWD: this.project,
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.root, "xdg/config"),
      XDG_DATA_HOME: join(this.root, "xdg/data"),
      XDG_STATE_HOME: join(this.root, "xdg/state"),
      XDG_CACHE_HOME: join(this.root, "xdg/cache"),
      OPENCODE_PASSWORD: PASSWORD,
      OMO_MEMORY_HOME: this.memoryRoot,
      OMO_E2E_PROBE_LOG: this.probeLog,
      ...(checker === null ? {} : { OMO_COMMENT_CHECKER_BIN: checker }),
      ...this.extraEnv,
    }
  }

  get serverUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  serverLog(): string {
    return ["serve.out", "serve.log"].map((file) => (existsSync(join(this.root, file)) ? readFileSync(join(this.root, file), "utf8") : "")).join("\n")
  }

  async start(models: readonly string[] = []): Promise<void> {
    this.port = await freePort()
    this.server = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(this.port), "--print-logs", "--log-level", "info"], {
      cwd: this.project,
      env: this.env(),
      stdout: Bun.file(join(this.root, "serve.out")),
      stderr: Bun.file(join(this.root, "serve.log")),
    })
    await waitFor("the server to accept connections", () => fetch(this.serverUrl).then(() => true, () => undefined), 30_000)
    await this.api("agent.list")
    await waitFor("the plugin to load", () => (this.serverLog().includes("[omo-opencode2] loaded in OpenCode") ? true : undefined), 30_000)
    for (const integrationID of this.credentials) await this.importRealCredential(integrationID)
    // Providers finish loading after the plugin; a run issued before that fails with `provider.no-route`.
    await waitFor(
      `models ${models.join(", ")} to be available`,
      async () => {
        const listed = (await this.api<{ data: { providerID: string; id: string }[] }>("model.list")).data.map((model) => `${model.providerID}/${model.id}`)
        return models.every((model) => listed.includes(model)) ? true : undefined
      },
      60_000,
    )
  }

  // Copies the user's own sign-in into the sandbox server over HTTP so the token never reaches argv or a log. The
  // refresh token stays behind: a sandbox that rotated it would sign the real OpenCode install out.
  private async importRealCredential(integrationID: string): Promise<void> {
    const db = new Database(REAL_DB, { readonly: true })
    const row = (() => {
      try {
        return db.query("select label, value from credential where integration_id = ? and active = 1").get(integrationID) as { label: string; value: string } | null
      } finally {
        db.close()
      }
    })()
    if (row === null) throw new Error(`no active ${integrationID} credential in the real OpenCode install; connect it there first`)
    const value = JSON.parse(row.value) as Record<string, unknown>
    if (value.type === "oauth" && typeof value.expires === "number" && value.expires < Date.now() + 3_600_000) {
      throw new Error(`the real ${integrationID} access token expires within an hour; refresh it in OpenCode first`)
    }
    const response = await fetch(`${this.serverUrl}/api/credential`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}`, "content-type": "application/json" },
      body: JSON.stringify({ integrationID, label: row.label, value: value.type === "oauth" ? { ...value, refresh: "" } : value }),
    })
    if (!response.ok) throw new Error(`credential.create for ${integrationID} failed: ${response.status} ${(await response.text()).slice(0, 300)}`)
  }

  async stop(): Promise<void> {
    this.server?.kill()
    await this.server?.exited
    this.server = undefined
  }

  async dispose(): Promise<void> {
    await this.stop()
    if (process.env.OMO_E2E_KEEP === "1") console.log(`[e2e] kept sandbox at ${this.root}`)
    else await rm(this.root, { recursive: true, force: true })
  }

  requestModels(sessionID: string): string[] {
    return this.probeRequests(sessionID, "primary").map((entry) => entry.model)
  }

  private async cli(args: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["opencode", ...args], { cwd: this.project, env: this.env(), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    clearTimeout(timer)
    return { exitCode, stdout, stderr }
  }

  async api<T = unknown>(operation: string, params: Record<string, string> = {}, data?: unknown): Promise<T> {
    const args = ["api", "--server", this.serverUrl, operation, "--param", `directory=${this.project}`]
    for (const [key, value] of Object.entries(params)) args.push("--param", `${key}=${value}`)
    if (data !== undefined) args.push("-d", JSON.stringify(data))
    const result = await this.cli(args, 60_000)
    if (result.exitCode !== 0) throw new Error(`opencode api ${operation} failed (${result.exitCode}): ${result.stderr || result.stdout}`)
    return (result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout)) as T
  }

  /** One user turn through the real CLI; words are separate argv items so the stored text is not wrapped in quotes. */
  async run(sessionID: string, text: string, options: { model?: string; agent?: string } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    // A fixed title skips OpenCode's title-generation request, which would spend the free models' daily quota.
    const args = ["run", "--server", this.serverUrl, "-s", sessionID, "--title", "omo e2e", "--format", "json", "--auto"]
    if (options.model !== undefined) args.push("-m", options.model)
    if (options.agent !== undefined) args.push("--agent", options.agent)
    args.push(...text.split(" "))
    const result = await this.cli(args, 240_000)
    const freeLimit = /"type":"provider\.free-limit".*?"retryAfterMs":(\d+)/.exec(result.stdout)
    if (freeLimit !== null) {
      const hours = (Number(freeLimit[1]) / 3_600_000).toFixed(1)
      throw new Error(`OpenCode's free usage limit is reached for ${options.model ?? "the session model"}; it resets in about ${hours} h. Rerun then, or run \`bun run test:e2e:stub\`.`)
    }
    if (result.exitCode !== 0) throw new Error(`opencode run failed (${result.exitCode}):\n${result.stderr.slice(-1500)}\n${result.stdout.slice(-1500)}`)
    return result
  }

  probe(): ProbeEntry[] {
    if (!existsSync(this.probeLog)) return []
    return readFileSync(this.probeLog, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ProbeEntry)
  }

  private probeRequests(sessionID: string, requestKind: string): ProbeRequest[] {
    return this.probe().filter((entry): entry is ProbeRequest => entry.kind === "request" && entry.sessionID === sessionID && entry.requestKind === requestKind)
  }

  requests(sessionID: string, requestKind = "primary"): ChatBody[] {
    return this.probeRequests(sessionID, requestKind).map((entry) => parseRequestBody(entry.body))
  }

  exchanges(sessionID: string): ToolExchange[] {
    const socketCalls = this.probe().filter((entry): entry is ProbeCall => entry.kind === "ws-call" && entry.sessionID === sessionID)
    const calls: ChatBody = { model: "", messages: socketCalls.map((call) => ({ role: "assistant", tool_calls: [{ id: call.callID, function: { name: call.name, arguments: call.arguments } }] })) }
    return toolExchanges([calls, ...this.requests(sessionID)])
  }

  /** The non-system conversation the model has seen so far: the last full request, or every incremental socket frame. */
  transcript(sessionID: string): ChatMessage[] {
    const entries = this.probeRequests(sessionID, "primary")
    const bodies = entries.map((entry) => parseRequestBody(entry.body))
    const seen = entries.some((entry) => entry.transport === "ws") ? bodies : bodies.slice(-1)
    return seen.flatMap((body) => body.messages.filter((message) => message.role !== "system"))
  }

  lastRequest(sessionID: string): ChatBody {
    const last = this.requests(sessionID).at(-1)
    if (last === undefined) throw new Error(`no model request was recorded for ${sessionID}`)
    return last
  }

  /** Compacts the session through the API and waits for the compaction request and the run that carries it to finish. */
  async compact(sessionID: string): Promise<void> {
    const before = this.probe().length
    await this.api("session.compact", { sessionID }, {})
    await waitFor(
      "the compaction to finish",
      () => {
        const after = this.probe().slice(before)
        const compaction = after.findIndex((entry) => entry.kind === "request" && entry.sessionID === sessionID && entry.requestKind === "compaction")
        if (compaction === -1) return undefined
        return after.slice(compaction).some((entry) => entry.kind === "event" && entry.type === "session.execution.succeeded" && entry.sessionID === sessionID) ? true : undefined
      },
      180_000,
    )
  }

  memoryIdentity(): MemoryIdentity {
    return resolveAutoIdentity(this.project, { OMO_MEMORY_HOME: this.memoryRoot }, "path")
  }

  async externalMemoryWrite(params: Record<string, unknown>, commitSessionId = "opencode2:external"): Promise<string> {
    const identity = this.memoryIdentity()
    const { repo, lock } = await prepareMemoryEngine(identity)
    const result = await runMemoryTool({
      repo,
      lock,
      params: { reason: "external write", ...params, command: String(params.command), author: { agentId: identity.id, authorName: identity.id }, provenance: { sessionId: commitSessionId, userTurns: 1, claim: { source: "agent" } } },
    })
    return result.message
  }

  async gitLog(format: string): Promise<string> {
    const proc = Bun.spawn(["git", "-C", this.memoryIdentity().paths.repo, "log", `--format=${format}`], { stdout: "pipe", stderr: "pipe" })
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return out
  }

  realMemoryLeak(): boolean {
    return existsSync(join(REAL_MEMORY_AGENTS, this.memoryIdentity().id))
  }

  file(path: string): string | undefined {
    const full = join(this.project, path)
    return existsSync(full) ? readFileSync(full, "utf8") : undefined
  }

  async writeProjectFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(join(this.project, path)), { recursive: true })
    await writeFile(join(this.project, path), content)
  }
}
