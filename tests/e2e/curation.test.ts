import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Sandbox, lastUserText, newSessionID, systemText, toolExchanges, toolNames, waitFor, type ChatBody, type ProbeRequest } from "./harness.ts"
import { STUB_ENV, startStubProvider, stubProviderConfig, type StubCall } from "./stub-provider.ts"

// Background reflection and dream runs answered by a scripted provider: each lane is told apart by its persona and
// gets the tool calls its test queues, so the runs, the tool's refusals and the parent's notice are deterministic.
setDefaultTimeout(180_000)

const MODEL = "stub/gpt-5.6-sol"
const REFLECTION_AGENT = "omo-memory-reflection"
const DREAM_AGENT = "omo-memory-dream"
const LANES = { reflection: "You are a memory reflection agent", dream: "You are a memory dream agent" } as const

const queues: Record<"main" | "reflection" | "dream", StubCall[]> = { main: [], reflection: [], dream: [] }
const provider = startStubProvider((body) => {
  const system = systemText(body)
  const lane = system.includes(LANES.reflection) ? "reflection" : system.includes(LANES.dream) ? "dream" : "main"
  const next = queues[lane][0]
  if (next === undefined || !(body.tools ?? []).some((tool) => tool.function.name === next.name)) return { text: "nothing to persist" }
  queues[lane].shift()
  return { call: next }
})

const boxes: Sandbox[] = []

async function sandbox(pluginOptions: Record<string, unknown>, memory: Record<string, unknown>): Promise<Sandbox> {
  const box = await Sandbox.create({
    pluginOptions: { mcp: false, models: { "omo/quick": MODEL }, ...pluginOptions },
    omoConfig: { memory },
    env: STUB_ENV,
    providers: { stub: stubProviderConfig(provider.baseURL, ["gpt-5.6-sol"]) },
  })
  boxes.push(box)
  await box.externalMemoryWrite({ command: "create", file_path: "notes/seeded.md", description: "seeded e2e note", file_text: "SEEDED-MARKER\n" }, "opencode2:seed")
  await box.start([MODEL])
  return box
}

function curatorSessions(box: Sandbox, agent: string): string[] {
  const requests = box.probe().filter((entry): entry is ProbeRequest => entry.kind === "request" && entry.agent === agent)
  return [...new Set(requests.map((entry) => entry.sessionID))]
}

async function parentOf(box: Sandbox, sessionID: string): Promise<string | undefined> {
  return (await box.api<{ data: { parentID?: string } }>("session.get", { sessionID })).data.parentID
}

async function runEnd(box: Sandbox, sessionID: string): Promise<void> {
  await waitFor(`${sessionID} to finish its run`, () => (box.probe().some((entry) => entry.kind === "event" && entry.type === "session.execution.succeeded" && entry.sessionID === sessionID) ? true : undefined), 60_000)
}

function firstRequest(box: Sandbox, sessionID: string): ChatBody {
  const first = box.requests(sessionID)[0]
  if (first === undefined) throw new Error(`no request was recorded for ${sessionID}`)
  return first
}

function expectCuratorTools(body: ChatBody): void {
  const tools = toolNames(body)
  expect(tools).toContain("memory")
  expect(tools).toContain("read")
  for (const name of ["shell", "patch", "edit", "write", "subagent", "skill", "webfetch"]) expect(tools).not.toContain(name)
}

afterAll(async () => {
  for (const box of boxes) await box.dispose()
  await provider.stop()
})

describe("background reflection", () => {
  let box: Sandbox
  let repo = ""

  test("compaction hands the conversation to a reflection run whose note reaches the parent", async () => {
    box = await sandbox({ dream: false }, { reflection: { trigger: { step_count: 3, on_compaction: true } } })
    repo = box.memoryIdentity().paths.repo
    const session = newSessionID()
    await box.run(session, "Remember that the deploy marker is MARKER-COMPACT.", { model: MODEL })
    queues.reflection.push({ name: "memory", args: { command: "create", file_path: "notes/reflected.md", description: "reflected e2e note", file_text: "REFLECTED-MARKER\n", reason: "reflect the deploy marker", source: "agent" } })
    await box.compact(session)
    await waitFor("the reflection note", () => (existsSync(join(repo, "notes/reflected.md")) ? true : undefined), 60_000)

    const child = curatorSessions(box, REFLECTION_AGENT)[0]
    if (child === undefined) throw new Error("no reflection session made a request")
    await runEnd(box, child)
    const first = firstRequest(box, child)
    expect(lastUserText(first)).toContain('<omo-memory-reflection trigger="compaction"')
    expect(lastUserText(first)).toContain("MARKER-COMPACT")
    expect(systemText(first)).toContain(LANES.reflection)
    expect(systemText(first)).toContain(`- MEMORY_DIR: ${repo}`)
    expectCuratorTools(first)
    expect(await parentOf(box, child)).toBe(session)
    expect(await box.gitLog("%(trailers:key=Omo-Session,valueonly)")).toContain(`opencode2:${child}`)

    await box.run(session, "say ok", { model: MODEL })
    const parent = box.lastRequest(session)
    expect(systemText(parent)).toContain("reflected.md")
    const subagent = (parent.tools ?? []).find((tool) => tool.function.name === "subagent")
    expect(subagent?.function.description).toContain("omo/explore")
    expect(subagent?.function.description).not.toContain("omo-memory")
  })

  test("enough steps start a reflection that cannot delete, add a skill, touch boundaries or read outside memory", async () => {
    const session = newSessionID()
    await box.run(session, "say ok", { model: MODEL })
    const before = curatorSessions(box, REFLECTION_AGENT).length
    const boundaries = readFileSync(join(repo, "system/boundaries.md"), "utf8")
    queues.reflection.push(
      { name: "memory", args: { command: "delete", file_path: "notes/reflected.md", reason: "drop it", source: "agent" } },
      { name: "memory", args: { command: "create", file_path: "skills/new-skill/SKILL.md", description: "a new skill", file_text: "steps\n", reason: "add a skill", source: "agent" } },
      { name: "memory", args: { command: "str_replace", file_path: "system/boundaries.md", old_string: "IDENTITY", new_string: "CHANGED", reason: "edit boundaries", source: "agent" } },
      { name: "read", args: { path: join(box.project, "sub/notes.txt") } },
      { name: "read", args: { path: join(repo, "notes/seeded.md") } },
      { name: "memory", args: { command: "create", file_path: "notes/steps.md", description: "step-triggered e2e note", file_text: "STEPS-MARKER\n", reason: "reflect after steps", source: "agent" } },
    )
    queues.main.push(...[1, 2, 3].map(() => ({ name: "read", args: { path: "sub/notes.txt" } })))
    await box.run(session, "read the notes three times", { model: MODEL })
    await waitFor("the step-triggered note", () => (existsSync(join(repo, "notes/steps.md")) ? true : undefined), 60_000)

    const child = curatorSessions(box, REFLECTION_AGENT)[before]
    if (child === undefined) throw new Error("no second reflection session made a request")
    await runEnd(box, child)
    expect(lastUserText(firstRequest(box, child))).toContain('<omo-memory-reflection trigger="steps"')
    const results = toolExchanges(box.requests(child)).map((exchange) => `${exchange.name}: ${exchange.result ?? ""}`)
    expect(results[0]).toContain("never delete")
    expect(results[1]).toContain("never add a new skill")
    expect(results[2]).toContain("leave system/boundaries.md to the user")
    expect(results[3]).not.toContain("hello from the notes file")
    expect(results[4]).toContain("SEEDED-MARKER")
    expect(existsSync(join(repo, "notes/reflected.md"))).toBe(true)
    expect(existsSync(join(repo, "skills/new-skill"))).toBe(false)
    expect(readFileSync(join(repo, "system/boundaries.md"), "utf8")).toBe(boundaries)

    await box.run(session, "say ok", { model: MODEL })
    const user = lastUserText(box.lastRequest(session))
    expect(user).toContain("<memory_notice>")
    expect(user).toContain("notes/steps.md")
  })
})

describe("background dream", () => {
  test("an idle server runs one dream over the memory inventory", async () => {
    const box = await sandbox({ reflection: false }, { dream: { idle_minutes: 0 } })
    const repo = box.memoryIdentity().paths.repo
    queues.dream.push({ name: "memory", args: { command: "rename", old_path: "notes/seeded.md", new_path: "reference/seeded.md", reason: "move the seeded note to reference", source: "agent" } })
    const session = newSessionID()
    await box.run(session, "say ok", { model: MODEL })
    await waitFor("the dream move", () => (existsSync(join(repo, "reference/seeded.md")) ? true : undefined), 60_000)

    const child = curatorSessions(box, DREAM_AGENT)[0]
    if (child === undefined) throw new Error("no dream session made a request")
    const first = firstRequest(box, child)
    expect(lastUserText(first)).toContain("<omo-memory-dream")
    expect(lastUserText(first)).toContain("system/ estimate: about")
    expect(lastUserText(first)).toContain("- notes/seeded.md ")
    expect(systemText(first)).toContain(LANES.dream)
    expectCuratorTools(first)
    expect(await parentOf(box, child)).toBe(session)
    const statePath = join(box.memoryIdentity().paths.runtime, "opencode2-dream.json")
    const head = (await box.gitLog("%H")).split("\n")[0]
    const state = await waitFor(
      "the dream state to record the HEAD after the run",
      () => {
        const parsed = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as { lastHead?: string; lastDreamAt?: string }) : undefined
        return parsed?.lastHead === head ? parsed : undefined
      },
      30_000,
    )
    expect(state.lastDreamAt).toBeDefined()
  })
})
