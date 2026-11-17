import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"
import { WEB_RESEARCH_INSTRUCTIONS } from "../../src/prompts/web-research.ts"
import { PLUGIN_ROOT, Sandbox, newSessionID, systemText, toolNames } from "./harness.ts"
import { STUB_ENV, followInstructions, startStubProvider, stubProviderConfig } from "./stub-provider.ts"

setDefaultTimeout(120_000)

const MODEL_ID = "glm-5.3-flash-free"
const MODEL = `stub/${MODEL_ID}`
const provider = startStubProvider(followInstructions)
const providers = { stub: stubProviderConfig(provider.baseURL, [MODEL_ID]) }
const pluginOptions = { mainPrompt: false, mcp: false, memory: false, commentChecker: false, lspDiagnostics: false, ulwExecuteContinuation: false }
let connected: Sandbox
let unavailable: Sandbox

beforeAll(async () => {
  connected = await Sandbox.create({ pluginOptions, providers, env: STUB_ENV })
  await connected.writeProjectFile("opencode.jsonc", JSON.stringify({
    plugins: [
      { package: PLUGIN_ROOT, options: pluginOptions },
      join(PLUGIN_ROOT, "tests/e2e/probe"),
      join(PLUGIN_ROOT, "tests/e2e/web-research-fixture"),
    ],
    providers,
    agents: {
      "omo/plan-reviewer": { permissions: [{ action: "exa_*", resource: "*", effect: "deny" }] },
    },
  }))
  await connected.start([MODEL])
  unavailable = await Sandbox.create({ pluginOptions, providers, env: STUB_ENV })
  await unavailable.start([MODEL])
})

afterAll(async () => {
  await connected?.dispose()
  await unavailable?.dispose()
  await provider.stop()
})

test.each(["sisyphus", "omo/quick", "omo/librarian"])("delivers the shared policy to %s with mainPrompt disabled and no Exa", async (agent) => {
  // Given an agent without any Exa registration, including agents with their own system prompt.
  const session = newSessionID()

  // When the real server assembles a request for that agent.
  await unavailable.run(session, "Reply with pong.", { model: MODEL, agent })

  // Then it ships the full shared policy once and retains the existing fetch tool.
  const body = unavailable.lastRequest(session)
  expect(systemText(body).split(WEB_RESEARCH_INSTRUCTIONS).length - 1).toBe(1)
  expect(toolNames(body)).toContain("webfetch")
  expect(toolNames(body).some((name) => name.startsWith("exa_"))).toBe(false)
})

test("librarian can discover and call Exa search and fetch through Code Mode", async () => {
  // Given connected fixture tools and the shipped librarian permissions.
  const session = newSessionID()
  const code = 'return { paths: search({ namespace: "exa" }).items.map((item) => item.path), search: await tools.exa.web_search_exa({}), fetch: await tools.exa.web_fetch_exa({}), other: search({ namespace: "other" }).items }'

  // When the agent calls the actual Code Mode runtime.
  await connected.run(session, `Call the execute tool exactly once with exactly this JSON input: ${JSON.stringify({ code })}`, { model: MODEL, agent: "omo/librarian" })

  // Then both permitted tools execute, while unrelated and mutating tools stay hidden.
  const result = connected.exchanges(session).find((exchange) => exchange.name === "execute")?.result
  expect(result).toContain("exa_web_search_exa")
  expect(result).toContain("exa_web_fetch_exa")
  expect(result).not.toContain("delete_document")
  expect(result).not.toContain("tools.other")
  const tools = toolNames(connected.lastRequest(session))
  for (const name of ["write", "edit", "patch", "subagent", "memory"]) expect(tools).not.toContain(name)
})

test.each(["omo/explore", "omo/plan-consultant"])("%s can fetch with Exa without gaining search or other MCP tools", async (agent) => {
  // Given an agent that previously allowed only direct page retrieval.
  const session = newSessionID()
  const code = 'return { paths: search({ namespace: "exa" }).items.map((item) => item.path), fetch: await tools.exa.web_fetch_exa({}), other: search({ namespace: "other" }).items }'

  // When it discovers and calls Exa through Code Mode.
  await connected.run(session, `Call the execute tool exactly once with exactly this JSON input: ${JSON.stringify({ code })}`, { model: MODEL, agent })

  // Then only fetch is available from Exa and no unrelated tool is exposed.
  const result = connected.exchanges(session).find((exchange) => exchange.name === "execute")?.result
  expect(result).toContain("exa_web_fetch_exa")
  expect(result).not.toContain("web_search_exa")
  expect(result).not.toContain("delete_document")
  expect(result).not.toContain("tools.other")
})

test("user denial of Exa overrides the plugin permissions and leaves direct fetch available", async () => {
  // Given the plan-reviewer config denying all Exa tools after the plugin's permissions.
  const session = newSessionID()
  const code = 'return search({ namespace: "exa" }).items.map((item) => item.path)'

  // When the restricted agent searches the Code Mode catalog.
  await connected.run(session, `Call the execute tool exactly once with exactly this JSON input: ${JSON.stringify({ code })}`, { model: MODEL, agent: "omo/plan-reviewer" })

  // Then Exa cannot be discovered, but the policy and permitted fallback remain.
  const result = connected.exchanges(session).find((exchange) => exchange.name === "execute")?.result
  expect(result).toBeDefined()
  expect(result).not.toContain("tools.exa")
  const body = connected.lastRequest(session)
  expect(toolNames(body)).toContain("webfetch")
  expect(systemText(body)).toContain(WEB_RESEARCH_INSTRUCTIONS)
})
