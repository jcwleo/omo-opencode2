import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Sandbox, lastUserText, newSessionID, systemText, textOf, toolExchanges, toolNames, waitFor, type ChatBody, type ProbeRequest } from "./harness.ts"
import { STUB_ENV, startStubProvider, stubProviderConfig, type StubCall, type StubReply } from "./stub-provider.ts"

// The main session and the recall judge share one scripted provider; judge requests are generate calls that carry the
// <recall-request> envelope. A main step can hold its reply until the plugin logs the surfaced note, so which tool
// result carries the nudge never depends on timing.
setDefaultTimeout(180_000)

const MODEL = "stub/gpt-5.6-sol"
const RECALL_AGENT = "omo-memory-recall"
const HEADER = "Kibitzer, a background memory advisor, surfaced this stored note."
const SILENT = '{"search":[],"nudges":[]}'
const READ: StubCall = { name: "read", args: { path: "sub/notes.txt" } }
const FREEZE = "reference/payments-freeze.md"
const FREEZE_HINT = "The payments-freeze note records that a Friday deploy caused the 2026-10-03 outage, so payments deploys are frozen on Fridays."
const TRAIN = "reference/release-train.md"
const TRAIN_HINT = "The release-train note records that the train leaves Tuesdays at 10:00 KST with a Monday 18:00 KST cutoff."
const COFFEE = "notes/coffee.md"

type MainStep = { readonly call: StubCall; readonly afterSurfaced?: string }
const mainSteps: MainStep[] = []
const judgeReplies: string[] = []
let box: Sandbox

const provider = startStubProvider(async (body): Promise<StubReply> => {
  if (lastUserText(body).includes("<recall-request")) return { text: judgeReplies.shift() ?? SILENT }
  const step = mainSteps.shift()
  if (step === undefined) return { text: "done" }
  const path = step.afterSurfaced
  if (path !== undefined) await waitFor(`the judge to surface ${path}`, () => (box.serverLog().includes(`memory recall surfaced ${path}`) ? true : undefined), 60_000)
  return { call: step.call }
})

function judgeSessions(): string[] {
  const requests = box.probe().filter((entry): entry is ProbeRequest => entry.kind === "request" && entry.agent === RECALL_AGENT)
  return [...new Set(requests.map((entry) => entry.sessionID))]
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function expectNoSubagentTurn(requests: readonly ChatBody[]): void {
  for (const body of requests) for (const message of body.messages) expect(textOf(message.content)).not.toContain("<subagent sessionID=")
}

beforeAll(async () => {
  box = await Sandbox.create({
    pluginOptions: { mcp: false, models: { "omo/quick": MODEL }, reflection: false, dream: false },
    env: STUB_ENV,
    providers: { stub: stubProviderConfig(provider.baseURL, ["gpt-5.6-sol"]) },
  })
  const notes = [
    { file_path: FREEZE, description: "payments deploy freeze on fridays", file_text: "Deploys of the payments service are frozen on Fridays since the 2026-10-03 outage, which a Friday deploy caused.\n" },
    { file_path: TRAIN, description: "release train cadence and cutoff", file_text: "The release train leaves every Tuesday at 10:00 KST; the cutoff is Monday 18:00 KST.\n" },
    { file_path: COFFEE, description: "coffee order preferences", file_text: "Flat white with oat milk.\n" },
  ]
  for (const note of notes) await box.externalMemoryWrite({ command: "create", ...note }, "opencode2:seed")
  await box.start([MODEL])
})

afterAll(async () => {
  await box.dispose()
  await provider.stop()
})

describe("memory recall", () => {
  test("a judge that searches before nudging reaches the next tool result once, without waking or changing the main session", async () => {
    const session = newSessionID()
    judgeReplies.push('{"search":["payments","deploy","friday","금요일"],"nudges":[]}', JSON.stringify({ search: [], nudges: [{ path: FREEZE, hint: FREEZE_HINT }] }))
    mainSteps.push({ call: READ }, { call: READ, afterSurfaced: FREEZE })
    await box.run(session, "Schedule the payments deploy for Friday afternoon", { model: MODEL })

    const judges = judgeSessions()
    expect(judges).toHaveLength(1)
    const judge = judges[0] ?? ""
    const [first, final] = box.requests(judge, "generate")
    if (first === undefined || final === undefined) throw new Error("the recall judge made fewer than two generate calls")
    const envelope = lastUserText(first)
    expect(envelope).toContain('<recall-request max-items="2">')
    expect(envelope).toContain("<task>Schedule the payments deploy for Friday afternoon</task>")
    for (const card of [`- ${FREEZE} :: payments deploy freeze on fridays`, `- ${TRAIN} :: release train cadence and cutoff`, `- ${COFFEE} :: coffee order preferences`]) expect(envelope).toContain(card)
    expect(envelope).toContain("This is your first pass.")
    expect(lastUserText(final)).toContain('<search-results terms="payments, deploy, friday, 금요일">')
    expect(lastUserText(final)).toContain("frozen on Fridays")
    expect(lastUserText(final)).toContain("This is your final pass")

    const requests = box.requests(session)
    expect(requests).toHaveLength(3)
    expectNoSubagentTurn(requests)
    const carrying = toolExchanges(requests)
      .filter((exchange) => exchange.name === "read")
      .map((exchange) => exchange.result ?? "")
      .filter((result) => result.includes(`<recalled-memory source="[[${FREEZE}]]">`))
    expect(carrying).toHaveLength(1)
    expect(carrying[0]).toContain(HEADER)
    expect(carrying[0]).toContain(FREEZE_HINT)
    for (const body of requests) expect(toolNames(body).some((name) => name.startsWith("recall_"))).toBe(false)
    expect(new Set(requests.map(systemText)).size).toBe(1)
    expect(systemText(requests[0] ?? { model: "", messages: [] })).toContain("Relevant stored memory may arrive on its own as <recalled-memory> blocks")
    expect(systemText(requests[0] ?? { model: "", messages: [] })).not.toContain("<recalled-memory source=")
    await waitFor("the finished judge session to be removed", () => box.api("session.get", { sessionID: judge }).then(() => undefined, () => true), 30_000)
  })

  test("a nudge surfaced after the turn ends rides on the next user message; instruction hints, approvals and delivered notes are skipped", async () => {
    const session = newSessionID()
    const before = judgeSessions().length
    judgeReplies.push(JSON.stringify({ search: [], nudges: [{ path: TRAIN, hint: "Check the release train cutoff before tagging." }, { path: TRAIN, hint: TRAIN_HINT }] }))
    await box.run(session, "When is the release train cutoff for the next tag?", { model: MODEL })
    await waitFor(`the judge to surface ${TRAIN}`, () => (box.serverLog().includes(`memory recall surfaced ${TRAIN}`) ? true : undefined), 60_000)
    expect(occurrences(lastUserText(box.lastRequest(session)), "<recalled-memory")).toBe(0)

    await box.run(session, "ok", { model: MODEL })
    const carried = lastUserText(box.lastRequest(session))
    expect(occurrences(carried, `<recalled-memory source="[[${TRAIN}]]">`)).toBe(1)
    expect(carried).toContain(TRAIN_HINT)
    expect(carried).not.toContain("Check the release train cutoff")
    expect(judgeSessions()).toHaveLength(before + 1)

    await box.run(session, "When is the release train cutoff again?", { model: MODEL })
    const judge = await waitFor("a judge for the follow-up prompt", () => judgeSessions()[before + 1], 60_000)
    const envelope = await waitFor("the follow-up judge's request", () => box.requests(judge, "generate")[0], 60_000)
    expect(lastUserText(envelope)).not.toContain(`- ${TRAIN} ::`)
    expect(lastUserText(envelope)).toContain(`- ${FREEZE} ::`)
    const requests = box.requests(session)
    expectNoSubagentTurn(requests)
    const transcript = box
      .lastRequest(session)
      .messages.map((message) => textOf(message.content))
      .join("\n")
    expect(occurrences(transcript, `<recalled-memory source="[[${TRAIN}]]">`)).toBe(1)
  })
})
