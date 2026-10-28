import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { presetPromptFor } from "../../src/prompts/presets.ts"
import { categoryPromptAppend, isGpt6AstraModel } from "../../src/prompts/model-variants.generated.js"
import { INTERNAL_SKILL_IDS } from "../../src/skills/ids.ts"
import { GLM, PLUGIN_ROOT, Sandbox, lastUserText, newSessionID, realSessionCount, systemText, textOf, toolNames, waitFor, type ChatBody, type ToolExchange } from "./harness.ts"
import { STUB_ENV, followInstructions, startStubProvider, stubProviderConfig, type StubProvider } from "./stub-provider.ts"

setDefaultTimeout(240_000)

// OMO_E2E_MODEL picks the model (`provider/model#variant`); "stub" swaps glm for an in-process stand-in that carries
// the same model id, so the preset and category paths match while the suite runs without any provider quota.
const USE_STUB = process.env.OMO_E2E_MODEL === "stub"
const MODEL = USE_STUB ? "stub/glm-5.3-flash-free" : (process.env.OMO_E2E_MODEL ?? GLM)
const MODEL_REF = MODEL.split("#")[0] ?? MODEL
const VARIANT = MODEL.includes("#") ? MODEL.slice(MODEL.indexOf("#") + 1) : undefined
const PROVIDER = MODEL_REF.slice(0, MODEL_REF.indexOf("/"))
const MODEL_ID = MODEL_REF.slice(MODEL_REF.indexOf("/") + 1)
// OpenCode gives GPT-family models `patch` instead of `edit`/`write`.
const USES_PATCH = /gpt-/.test(MODEL_ID) && !/oss|gpt-4/.test(MODEL_ID)
const SIGNED_IN_PROVIDER = !USE_STUB && PROVIDER !== "opencode"
const NUDGE_EVERY = 3
const SG_BINARY = process.env.OMO_AST_GREP_SG_PATH ?? Bun.which("sg") ?? Bun.which("ast-grep")
const realSessionsBefore = realSessionCount()

function skillBody(id: string): string {
  return readFileSync(join(PLUGIN_ROOT, "skills", id, "SKILL.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
}

function distinctiveLine(body: string, absentFrom = ""): string {
  const line = body.split("\n").find((candidate) => candidate.trim().length >= 40 && !absentFrom.includes(candidate.trim()))
  if (line === undefined) throw new Error("no distinctive line in the skill body")
  return line.trim()
}

function presetHead(): string {
  const preset = presetPromptFor(PROVIDER, MODEL_ID, {})
  if (preset === undefined) throw new Error(`no Senpi preset matches ${MODEL_REF}`)
  return preset.slice(0, 120)
}

function memoryBlock(body: ChatBody): string {
  const text = systemText(body)
  const start = text.indexOf("<!-- senpi-memory:")
  const end = text.indexOf(":end -->", start)
  return start === -1 || end === -1 ? "" : text.slice(start, end + ":end -->".length)
}

function requireExchange(exchanges: readonly ToolExchange[], what: string, match: (exchange: ToolExchange) => boolean): ToolExchange {
  const found = exchanges.find((exchange) => match(exchange) && exchange.result !== undefined)
  if (found !== undefined) return found
  const seen = exchanges.map((exchange) => `${exchange.name}(${JSON.stringify(exchange.args).slice(0, 160)}) -> ${(exchange.result ?? "<no result>").slice(0, 160)}`)
  throw new Error(`the model never completed ${what}; tool calls seen:\n${seen.join("\n") || "(none)"}`)
}

function callTool(name: string, input: Record<string, unknown>, after = "reply with the word done"): string {
  return `Call the ${name} tool exactly once with exactly this JSON input: ${JSON.stringify(input)} Do not call any other tool. After the tool result, reply with the word done.`.replace(
    "reply with the word done.",
    `${after}.`,
  )
}

const CREATE_FILE = USES_PATCH
  ? { tool: "patch", input: (path: string, content: string) => ({ patchText: `*** Begin Patch\n*** Add File: ${path}\n${content.replace(/\n$/, "").split("\n").map((line) => `+${line}`).join("\n")}\n*** End Patch` }) }
  : { tool: "write", input: (path: string, content: string) => ({ path, content }) }

const creates = (path: string) => (exchange: ToolExchange) => exchange.name === CREATE_FILE.tool && JSON.stringify(exchange.args).includes(path)

let box: Sandbox
let stub: StubProvider | undefined
let identityRepo = ""
const S1 = newSessionID()

beforeAll(async () => {
  stub = USE_STUB ? startStubProvider(followInstructions) : undefined
  box = await Sandbox.create({
    pluginOptions: { models: { "omo/deep-low": MODEL } },
    omoConfig: {
      categories: { quick: { model: MODEL } },
      memory: { nudge: { enabled: true, every_user_turns: NUDGE_EVERY } },
    },
    ...(stub === undefined ? {} : { env: STUB_ENV, providers: { stub: stubProviderConfig(stub.baseURL, [MODEL_ID]) } }),
    ...(SIGNED_IN_PROVIDER ? { credentials: [PROVIDER] } : {}),
  })
  await box.externalMemoryWrite({ command: "create", file_path: "notes/seeded.md", description: "seeded e2e note", file_text: "SEEDED-MARKER\n" }, "opencode2:seed")
  identityRepo = box.memoryIdentity().paths.repo
  await box.start([MODEL_REF])
}, 120_000)

afterAll(async () => {
  await box?.dispose()
  await stub?.stop()
})

describe("plugin surface", () => {
  test("registers the public skills, the memory repo skill and one command per skill", async () => {
    const publicSkills = readdirSync(join(PLUGIN_ROOT, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !INTERNAL_SKILL_IDS.has(entry.name))
      .map((entry) => entry.name)
    expect(publicSkills.length).toBe(19)
    const skills = (await box.api<{ data: { id: string }[] }>("skill.list")).data.map((skill) => skill.id)
    for (const id of publicSkills) expect(skills).toContain(id)
    expect(skills).toContain("memory-discipline")
    for (const id of INTERNAL_SKILL_IDS) expect(skills).not.toContain(id)
    const commands = (await box.api<{ data: { name: string }[] }>("command.list")).data.map((command) => command.name)
    for (const id of publicSkills) expect(commands).toContain(id)
  })

  test("connects the four built-in MCP servers", async () => {
    const statuses = await waitFor(
      "every built-in MCP server to connect",
      async () => {
        const servers = (await box.api<{ data: { name: string; status: { status: string } }[] }>("mcp.list")).data
        const byName = Object.fromEntries(servers.map((server) => [server.name, server.status.status]))
        return ["context7", "grep_app", "ast_grep", "lsp"].every((name) => byName[name] === "connected") ? byName : undefined
      },
      90_000,
    )
    expect(Object.keys(statuses).sort()).toEqual(["ast_grep", "context7", "grep_app", "lsp"])
  })

  test("routes omo agents through omo.jsonc and the models option", async () => {
    const agentFiles = readdirSync(join(PLUGIN_ROOT, "agents/omo")).filter((file) => file.endsWith(".md"))
    const listed = await box.api<{ data: { id: string; model?: { providerID: string; id: string; variant?: string } }[] }>("agent.list")
    const omo = listed.data.filter((agent) => agent.id.startsWith("omo/"))
    expect(omo.map((agent) => agent.id).sort()).toEqual(agentFiles.map((file) => `omo/${file.replace(/\.md$/, "")}`).sort())
    const model = (id: string) => omo.find((agent) => agent.id === id)?.model
    const expected = { providerID: PROVIDER, id: MODEL_ID, ...(VARIANT === undefined ? {} : { variant: VARIANT }) }
    expect(model("omo/quick")).toMatchObject(expected)
    expect(model("omo/deep-low")).toMatchObject(expected)
  })

  test("registers the omo agents itself and removes the builtin general and explore", async () => {
    const listed = (await box.api<{ data: { id: string; mode: string; system?: string; permissions: { action: string; resource: string; effect: string }[] }[] }>("agent.list")).data
    const ids = listed.map((agent) => agent.id)
    expect(ids).not.toContain("general")
    expect(ids).not.toContain("explore")
    expect(listed.filter((agent) => agent.id.startsWith("omo/")).every((agent) => agent.mode === "subagent")).toBe(true)
    const subagentRules = (id: string) => listed.find((agent) => agent.id === id)?.permissions.filter((rule) => rule.action === "subagent").map((rule) => `${rule.resource}:${rule.effect}`)
    expect(subagentRules("omo/deep-low")).toEqual(["*:deny", "omo/explore:allow", "omo/librarian:allow"])
    expect(subagentRules("omo/quick")).toEqual(["*:deny"])
    const explorePrompt = readFileSync(join(PLUGIN_ROOT, "agents/omo/explore.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()
    expect(listed.find((agent) => agent.id === "omo/explore")?.system).toBe(explorePrompt)
    expect(listed.find((agent) => agent.id === "omo/deep-low")?.system).toBeUndefined()
  })
})

describe(`sisyphus agent on ${MODEL}`, () => {
  test("is the default agent in place of build, which stays registered but hidden", async () => {
    const listed = (await box.api<{ data: { id: string; mode: string; hidden: boolean; permissions: unknown[] }[] }>("agent.list")).data
    const sisyphus = listed.find((agent) => agent.id === "sisyphus")
    const build = listed.find((agent) => agent.id === "build")
    expect(sisyphus).toMatchObject({ mode: "primary", hidden: false })
    expect(build?.hidden).toBe(true)
    expect(sisyphus?.permissions).toEqual(build?.permissions)
  })

  test("uses the Senpi preset, projects memory, and exposes the migrated tools", async () => {
    await box.run(S1, "Reply with exactly the word pong and nothing else.", { model: MODEL })
    expect(box.probe().filter((entry) => entry.kind === "request" && entry.sessionID === S1).map((entry) => (entry.kind === "request" ? entry.agent : ""))).toContain("sisyphus")
    const body = box.lastRequest(S1)
    const system = systemText(body)
    expect(system.startsWith(presetHead())).toBe(true)
    const block = memoryBlock(body)
    expect(block.startsWith(`<!-- senpi-memory:${box.memoryIdentity().id}:begin -->`)).toBe(true)
    expect(block).toContain(`- MEMORY_DIR: ${identityRepo}`)
    expect(block).toContain("seeded.md")
    expect(block).toContain("read it with the `read` tool")
    expect(block).not.toContain("recalled-memory")
    const tools = toolNames(body)
    for (const name of ["memory", "execute", "read", "lsp_diagnostics", "lsp_goto_definition", "lsp_find_references", "lsp_symbols"]) expect(tools).toContain(name)
    if (USES_PATCH) {
      expect(tools).toContain("patch")
      expect(tools).not.toContain("write")
    } else {
      expect(tools).toContain("write")
      expect(tools).toContain("edit")
      expect(tools).not.toContain("patch")
    }
    expect(system).toContain("# Code Mode")
  })

  test("ultrawork attaches the directive once, then the reminder, and again after compaction", async () => {
    const base = skillBody("ultrawork")
    const astra = skillBody("ultrawork-gpt-6-astra")
    const marker = isGpt6AstraModel(MODEL_ID) ? distinctiveLine(astra, base) : distinctiveLine(base, astra)
    const session = newSessionID()
    await box.run(session, "ulw reply with exactly the word pong", { model: MODEL })
    expect(lastUserText(box.lastRequest(session))).toContain(marker)
    await box.run(session, "ulw reply with exactly the word pong again", { model: MODEL })
    const second = box.lastRequest(session)
    expect(lastUserText(second)).toContain("<omo-ultrawork-reminder>")
    expect(lastUserText(second)).not.toContain(marker)
    await box.compact(session)
    await box.run(session, "ulw reply with exactly the word pong once more", { model: MODEL })
    expect(lastUserText(box.lastRequest(session))).toContain(marker)
  })

  test("points at ulw-plan and ulw-research when they are mentioned", async () => {
    const session = newSessionID()
    await box.run(session, "In one short sentence, what is ulw-plan for?", { model: MODEL })
    expect(lastUserText(box.lastRequest(session))).toContain("<omo-ulw-plan-pointer>")
    await box.run(session, "In one short sentence, what is ulw-research for?", { model: MODEL })
    const user = lastUserText(box.lastRequest(session))
    expect(user).toContain("<omo-ulw-research-pointer>")
    expect(user).toContain("`ultimate-browsing`")
  })

  test("a skill command runs with its skill attached", async () => {
    const marker = distinctiveLine(skillBody("git-master"))
    const session = newSessionID()
    await box.run(session, "Reply with exactly the word pong.", { model: MODEL })
    const before = box.requests(session).length
    await box.api("session.command", { sessionID: session }, { name: "git-master", text: "Reply with exactly the word pong." })
    const body = await waitFor("the git-master command turn", () => box.requests(session).slice(before).find((request) => lastUserText(request).includes(marker)), 120_000)
    expect(lastUserText(body)).toContain("Reply with exactly the word pong.")
  })
})

describe(`omo subagents on ${MODEL}`, () => {
  test("omo/explore keeps its curated read-only tools and its own prompt", async () => {
    const session = newSessionID()
    await box.run(session, "Reply with exactly the word pong.", { model: MODEL, agent: "omo/explore" })
    const body = box.lastRequest(session)
    expect(toolNames(body)).toEqual(["glob", "grep", "lsp_diagnostics", "lsp_find_references", "lsp_goto_definition", "lsp_symbols", "read", "shell", "webfetch"])
    const explorePrompt = readFileSync(join(PLUGIN_ROOT, "agents/omo/explore.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    expect(systemText(body)).toContain(distinctiveLine(explorePrompt))
    expect(systemText(body).startsWith(presetHead())).toBe(false)
  })

  test("omo/quick runs on the omo.jsonc model with its category context", async () => {
    const session = newSessionID()
    await box.run(session, "Reply with exactly the word pong.", { agent: "omo/quick" })
    expect(box.requestModels(session).every((model) => model === MODEL_REF)).toBe(true)
    const append = categoryPromptAppend("quick", MODEL_ID)
    expect(append).toBeDefined()
    const system = systemText(box.lastRequest(session))
    expect(system).toContain(append ?? "")
    expect(system.startsWith(presetHead())).toBe(true)
    expect(toolNames(box.lastRequest(session))).toContain("skill")
  })
})

describe(`edit and read hooks on ${MODEL}`, () => {
  test(`the comment checker flags a comment written with ${CREATE_FILE.tool}`, async () => {
    const session = newSessionID()
    await box.run(session, callTool(CREATE_FILE.tool, CREATE_FILE.input("src/commented.ts", "// TODO remove this explanatory comment\nexport const commented = 1\n")), { model: MODEL })
    const create = requireExchange(box.exchanges(session), `a ${CREATE_FILE.tool} of src/commented.ts`, creates("src/commented.ts"))
    expect(create.result).toContain(`comment-checker found issues in ${box.project}/src/commented.ts`)
  })

  test("LSP diagnostics follow an edit that breaks a type, and the lsp MCP tool reports it too", async () => {
    const session = newSessionID()
    await box.run(session, callTool(CREATE_FILE.tool, CREATE_FILE.input("src/broken.ts", 'export const broken: number = "not a number"\n')), { model: MODEL })
    const create = requireExchange(box.exchanges(session), `a ${CREATE_FILE.tool} of src/broken.ts`, creates("src/broken.ts"))
    expect(create.result).toContain(`LSP errors detected in ${box.project}/src/broken.ts`)
    expect(create.result).toMatch(/2322|not assignable/)
    await box.run(session, callTool("lsp_diagnostics", { filePath: "src/broken.ts" }, "reply with the error code it reports"), { model: MODEL })
    const diagnostics = requireExchange(box.exchanges(session), "an lsp_diagnostics call", (exchange) => exchange.name === "lsp_diagnostics")
    expect(diagnostics.result).toMatch(/2322|not assignable/)
  })

  test("Code Mode finds the ast_grep, context7 and grep_app tools", async () => {
    const session = newSessionID()
    const code = 'return ["ast_grep", "context7", "grep_app"].flatMap((namespace) => search({ namespace, limit: 10 }).items.map((item) => item.path))'
    await box.run(session, callTool("execute", { code }), { model: MODEL })
    const execute = requireExchange(box.exchanges(session), "an execute call of the Code Mode catalog", (exchange) => exchange.name === "execute")
    for (const path of ["tools.ast_grep.search", "tools.context7[", "resolve-library-id", "tools.grep_app.searchGitHub"]) expect(execute.result).toContain(path)
  })

  // The ast-grep CLI is an optional dependency: without it the MCP still registers but its tools answer BINARY_NOT_FOUND.
  test.skipIf(SG_BINARY === null)("ast_grep answers a structural search through Code Mode", async () => {
    const session = newSessionID()
    const code = 'return await tools.ast_grep.search({ pattern: "export const $NAME: number = $VALUE", language: "typescript", paths: ["src/index.ts"] })'
    await box.run(session, callTool("execute", { code }, "reply with the constant name it matched"), { model: MODEL })
    const execute = requireExchange(box.exchanges(session), "an execute call of ast_grep.search", (exchange) => exchange.name === "execute")
    expect(execute.result).toContain("answer")
  })

  test("reading a file under sub/ brings in that directory's AGENTS.md exactly once", async () => {
    const session = newSessionID()
    await box.run(session, callTool("read", { path: "sub/notes.txt" }, "reply with its content"), { model: MODEL })
    const read = requireExchange(box.exchanges(session), "a read of sub/notes.txt", (exchange) => exchange.name === "read" && String(exchange.args.path).endsWith("notes.txt"))
    expect(read.result).toContain("hello from the notes file")
    const carriers = box.transcript(session).filter((message) => textOf(message.content).includes("SUB-MARKER"))
    expect(carriers.length).toBe(1)
  })
})

describe(`omo memory on ${MODEL}`, () => {
  const readRepoFile = (path: string): string | undefined => (existsSync(join(identityRepo, path)) ? readFileSync(join(identityRepo, path), "utf8") : undefined)
  const M1 = newSessionID()

  test("memory create commits with this session's trailers", async () => {
    await box.run(M1, callTool("memory", { command: "create", file_path: "notes/glm.md", description: "glm e2e note", file_text: "GLM-MARKER", reason: "Record the glm marker", source: "agent" }), { model: MODEL })
    const create = requireExchange(box.exchanges(M1), "a memory create", (exchange) => exchange.name === "memory" && exchange.args.command === "create")
    expect(create.result).toMatch(/Memory create committed locally \([0-9a-f]{7}\)/)
    expect(readRepoFile("notes/glm.md")).toContain("GLM-MARKER")
    const log = await box.gitLog("%s|%(trailers:key=Omo-Session,valueonly,separator=)|%(trailers:key=Omo-Claim-Source,valueonly,separator=)")
    expect(log).toContain(`Record the glm marker|opencode2:${M1}|agent`)
  })

  test("the other memory commands work through the tool", async () => {
    const steps: { input: Record<string, unknown>; check: () => boolean }[] = [
      { input: { command: "str_replace", file_path: "notes/glm.md", old_string: "GLM-MARKER", new_string: "GLM-EDITED", reason: "Edit the glm marker", source: "agent" }, check: () => readRepoFile("notes/glm.md")?.includes("GLM-EDITED") === true },
      { input: { command: "insert", file_path: "notes/glm.md", insert_line: 1, insert_text: "INSERTED-LINE", reason: "Insert a line into the glm note", source: "agent" }, check: () => readRepoFile("notes/glm.md")?.includes("INSERTED-LINE") === true },
      { input: { command: "update_description", file_path: "notes/glm.md", description: "glm e2e note updated", reason: "Update the glm note description", source: "agent" }, check: () => readRepoFile("notes/glm.md")?.includes("glm e2e note updated") === true },
      { input: { command: "rename", old_path: "notes/glm.md", new_path: "notes/glm-renamed.md", reason: "Rename the glm note", source: "agent" }, check: () => readRepoFile("notes/glm-renamed.md") !== undefined && readRepoFile("notes/glm.md") === undefined },
      {
        input: { command: "apply_patch", input: "*** Begin Patch\n*** Add File: notes/patched.md\n+---\n+description: patched note\n+---\n+PATCHED-MARKER\n*** End Patch", reason: "Add a note by patch", source: "agent" },
        check: () => readRepoFile("notes/patched.md")?.includes("PATCHED-MARKER") === true,
      },
      { input: { command: "delete", file_path: "notes/patched.md", reason: "Delete the patched note", source: "agent" }, check: () => readRepoFile("notes/patched.md") === undefined },
    ]
    for (const step of steps) {
      const before = box.exchanges(M1).length
      await box.run(M1, callTool("memory", step.input), { model: MODEL })
      const exchange = requireExchange(box.exchanges(M1).slice(before), `memory ${String(step.input.command)}`, (candidate) => candidate.name === "memory" && candidate.args.command === step.input.command)
      expect(exchange.result).toContain("committed locally")
      expect(step.check()).toBe(true)
    }
  })

  test("a short approval right after a proposal is recorded as the user's", async () => {
    const session = newSessionID()
    const input = { command: "create", file_path: "notes/tabs.md", description: "tab preference", file_text: "Prefers tabs.", reason: "Record the tab preference", source: "user", user_quote: "yes" }
    await box.run(
      session,
      `When I answer yes, call the memory tool exactly once with exactly this JSON input: ${JSON.stringify(input)} For now do not call any tool; reply with exactly this question: Shall I save that you prefer tabs?`,
      { model: MODEL },
    )
    await box.run(session, "yes", { model: MODEL })
    requireExchange(box.exchanges(session), "the approved memory create", (exchange) => exchange.name === "memory" && exchange.args.file_path === "notes/tabs.md")
    const log = await box.gitLog("%s|%(trailers:key=Omo-Claim-Source,valueonly,separator=)")
    expect(log).toContain("Record the tab preference|user")
    expect(readRepoFile("notes/tabs.md")).toContain('user replied \\"yes\\" to proposal')
  })

  test("a change committed elsewhere is announced without changing the pinned prompt", async () => {
    const pinned = memoryBlock(box.requests(S1)[0] ?? box.lastRequest(S1))
    await box.externalMemoryWrite({ command: "create", file_path: "notes/external.md", description: "external e2e note", file_text: "EXTERNAL-MARKER\n" })
    await box.run(S1, "Reply with exactly the word pong.", { model: MODEL })
    const body = box.lastRequest(S1)
    expect(memoryBlock(body)).toBe(pinned)
    const user = lastUserText(body)
    expect(user).toContain("<memory_notice>")
    expect(user).toContain("Memory changed after this session's prompt was pinned to")
    expect(user).toContain("notes/external.md")
    expect(systemText(body)).not.toContain("<memory_notice>")
  })

  test("compaction repins the projection at the current memory HEAD", async () => {
    await box.compact(S1)
    await box.run(S1, "Reply with exactly the word pong.", { model: MODEL })
    const body = box.lastRequest(S1)
    expect(memoryBlock(body)).toContain("external.md")
    expect(lastUserText(body)).not.toContain("Memory changed after this session's prompt was pinned to")
  })

  test("the save nudge appears after the configured turns and clears after a save", async () => {
    const session = newSessionID()
    const nudge = `${NUDGE_EVERY} user turns since your last memory save`
    for (let turn = 1; turn <= NUDGE_EVERY; turn++) {
      await box.run(session, `Reply with exactly the word pong${turn}.`, { model: MODEL })
      expect(lastUserText(box.lastRequest(session)).includes(nudge)).toBe(turn === NUDGE_EVERY)
    }
    await box.run(session, callTool("memory", { command: "create", file_path: "notes/nudge.md", description: "nudge e2e note", file_text: "NUDGE-MARKER", reason: "Save after the nudge", source: "agent" }), { model: MODEL })
    requireExchange(box.exchanges(session), "the save after the nudge", (exchange) => exchange.name === "memory" && exchange.args.file_path === "notes/nudge.md")
    await box.run(session, "Reply with exactly the word pong.", { model: MODEL })
    expect(lastUserText(box.lastRequest(session))).not.toContain("user turns since your last memory save")
  })
})

// A provider's prompt cache reuses the longest prefix it has seen, so each request must repeat the one before it.
// OpenCode moves its cache hints to the newest message on every request, so the comparison drops them with the shape
// they force on message content and keeps what the model reads: role, text, tool calls.
function conversation(body: ChatBody): string[] {
  return body.messages.map((message) => JSON.stringify([message.role, textOf(message.content), message.tool_calls ?? [], message.tool_call_id ?? ""]))
}

describe(`prompt cache stability on ${MODEL}`, () => {
  test("every request repeats the previous request's system prompt and conversation", async () => {
    const session = newSessionID()
    await box.run(session, "In one short sentence, what is ulw-plan for?", { model: MODEL })
    await box.externalMemoryWrite({ command: "create", file_path: "notes/stability.md", description: "stability e2e note", file_text: "STABILITY-MARKER\n" })
    await box.run(session, callTool("read", { path: "sub/notes.txt" }, "reply with its content"), { model: MODEL })
    for (const word of ["pong", "ping"]) await box.run(session, `Reply with exactly the word ${word}.`, { model: MODEL })
    const requests = box.requests(session)
    const userTexts = requests.flatMap((body) => body.messages.filter((message) => message.role === "user").map((message) => textOf(message.content)))
    for (const note of ["<omo-ulw-plan-pointer>", "Memory changed after this session's prompt was pinned to", `${NUDGE_EVERY} user turns since your last memory save`]) {
      expect(userTexts.some((text) => text.includes(note))).toBe(true)
    }
    requests.slice(1).forEach((next, index) => {
      const previous = requests[index] as ChatBody
      expect(systemText(next)).toBe(systemText(previous))
      expect(conversation(next).slice(0, previous.messages.length)).toEqual(conversation(previous))
    })
  })
})

describe(`ulw-execute continuation on ${MODEL}`, () => {
  test("drives an active plan to its checked box without another user prompt", async () => {
    const session = newSessionID()
    await box.writeProjectFile(
      ".omo/plans/e2e.md",
      "# E2E plan\n\n## TODOs\n\n- [ ] 1. Create the file `done.txt` in the project root containing exactly `ok`, then change this line's checkbox to `- [x]`.\n",
    )
    await box.writeProjectFile(
      ".omo/boulder.json",
      `${JSON.stringify(
        {
          schema_version: 2,
          active_work_id: "e2e-1",
          works: { "e2e-1": { work_id: "e2e-1", active_plan: ".omo/plans/e2e.md", plan_name: "e2e", session_ids: [`opencode2:${session}`], status: "active", worktree_path: null, started_at: new Date().toISOString() } },
        },
        null,
        2,
      )}\n`,
    )
    await box.run(session, "Reply with exactly the word ready.", { model: MODEL })
    await waitFor(
      "the continuation turns to create done.txt and check the box",
      () => (box.file("done.txt")?.trim() === "ok" && box.file(".omo/plans/e2e.md")?.includes("- [x] 1.") ? true : undefined),
      360_000,
    )
    const directives = new Set(box.requests(session).map(lastUserText).filter((text) => text.includes("<omo-ulw-execute-continuation>")))
    expect(directives.size).toBeGreaterThanOrEqual(1)
    expect(directives.size).toBeLessThanOrEqual(8)
  }, 420_000)
})

describe("isolation", () => {
  test("leaves the real OpenCode database and memory root untouched", () => {
    expect(box.realMemoryLeak()).toBe(false)
    expect(realSessionCount()).toBe(realSessionsBefore)
  })
})
