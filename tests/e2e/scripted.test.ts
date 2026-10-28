import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PLUGIN_ROOT, Sandbox, lastUserText, newSessionID, systemText, toolExchanges, toolNames } from "./harness.ts"
import { STUB_ENV, startStubProvider, stubProviderConfig, type StubCall } from "./stub-provider.ts"

// glm-5.3-flash gets edit/write and never patch, and no free model is GPT-6 Astra, so these GPT-only paths run
// against a scripted OpenAI-compatible provider that answers with the tool call each test queues.
setDefaultTimeout(120_000)

const queue: StubCall[] = []
const provider = startStubProvider((body) => {
  const next = queue[0]
  const offered = next !== undefined && body.messages.at(-1)?.role !== "tool" && (body.tools ?? []).some((tool) => tool.function.name === next.name)
  if (!offered || next === undefined) return { text: "ok" }
  queue.shift()
  return { call: next }
})

function skillBody(id: string): string {
  return readFileSync(join(PLUGIN_ROOT, "skills", id, "SKILL.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
}

function distinctiveLine(body: string, absentFrom: string): string {
  const line = body.split("\n").find((candidate) => candidate.trim().length >= 40 && !absentFrom.includes(candidate.trim()))
  if (line === undefined) throw new Error("no distinctive line in the skill body")
  return line.trim()
}

let box: Sandbox

beforeAll(async () => {
  box = await Sandbox.create({ pluginOptions: { mcp: false }, env: STUB_ENV, providers: { stub: stubProviderConfig(provider.baseURL, ["gpt-5.6-sol", "gpt-6-astra"]) } })
  await box.start(["stub/gpt-5.6-sol", "stub/gpt-6-astra"])
}, 120_000)

afterAll(async () => {
  await box?.dispose()
  await provider.stop()
})

describe("GPT-only paths (scripted provider)", () => {
  test("GPT models get patch instead of edit/write and the Senpi preset", async () => {
    const session = newSessionID()
    await box.run(session, "say ok", { model: "stub/gpt-5.6-sol" })
    const body = box.lastRequest(session)
    expect(toolNames(body)).toContain("patch")
    expect(toolNames(body)).not.toContain("edit")
    expect(toolNames(body)).not.toContain("write")
    expect(systemText(body)).toContain("## Intent Gate")
  })

  test("a patch that adds a commented, ill-typed file gets the comment check and LSP diagnostics", async () => {
    const session = newSessionID()
    queue.push({ name: "patch", args: { patchText: '*** Begin Patch\n*** Add File: src/patched.ts\n+// leftover explanatory comment\n+export const patched: number = "text"\n*** End Patch' } })
    await box.run(session, "apply the patch", { model: "stub/gpt-5.6-sol" })
    const result = toolExchanges(box.requests(session)).find((exchange) => exchange.name === "patch")?.result ?? ""
    expect(result).toContain(`comment-checker found issues in ${box.project}/src/patched.ts`)
    expect(result).toContain(`LSP errors detected in ${box.project}/src/patched.ts`)
    expect(result).toMatch(/2322|not assignable/)
  })

  test("a patch that edits an existing file is checked against its before and after text", async () => {
    await box.writeProjectFile("src/existing.ts", "export const existing = 1\n")
    const session = newSessionID()
    queue.push({ name: "patch", args: { patchText: "*** Begin Patch\n*** Update File: src/existing.ts\n@@\n-export const existing = 1\n+// a freshly added explanatory comment\n+export const existing = 2\n*** End Patch" } })
    await box.run(session, "apply the patch", { model: "stub/gpt-5.6-sol" })
    const result = toolExchanges(box.requests(session)).find((exchange) => exchange.name === "patch")?.result ?? ""
    expect(result).toContain(`comment-checker found issues in ${box.project}/src/existing.ts`)
  })

  test("a GPT-6 Astra request carries the Astra ultrawork directive instead of the base one", async () => {
    const base = skillBody("ultrawork")
    const astra = skillBody("ultrawork-gpt-6-astra")
    const session = newSessionID()
    await box.run(session, "ulw say ok", { model: "stub/gpt-6-astra" })
    const user = lastUserText(box.lastRequest(session))
    expect(user).toContain(distinctiveLine(astra, base))
    expect(user).not.toContain(distinctiveLine(base, astra))
  })
})
