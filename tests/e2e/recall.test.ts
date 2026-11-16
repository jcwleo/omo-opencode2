import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Sandbox, lastUserText, newSessionID, systemText, textOf, toolExchanges, toolNames, waitFor, type ChatBody, type ProbeRequest } from "./harness.ts"
import { STUB_ENV, startStubProvider, stubProviderConfig, type StubCall, type StubReply } from "./stub-provider.ts"

// The main session and the recall judge share one scripted provider, told apart by the judge's persona. A main step can
// hold its reply until the judge's nudge is recorded, so which tool result carries the nudge never depends on timing.
setDefaultTimeout(180_000)

const MODEL = "stub/gpt-5.6-sol"
const RECALL_AGENT = "omo-memory-recall"
const JUDGE_PERSONA = "You are a memory recall judge"
const HEADER = "Kibitzer, a background memory advisor, surfaced this stored note."
const NUDGE_WAIT_MS = 60_000
const READ: StubCall = { name: "read", args: { path: "sub/notes.txt" } }
const FREEZE = "reference/payments-freeze.md"
const FREEZE_HINT = "The payments-freeze note records that a Friday deploy caused the 2026-10-03 outage, so payments deploys are frozen on Fridays."
const TRAIN = "reference/release-train.md"
const TRAIN_HINT = "The release-train note records that the train leaves Tuesdays at 10:00 KST with a Monday 18:00 KST cutoff."
const COFFEE = "notes/coffee.md"

type MainStep = { readonly call: StubCall; readonly afterNudge?: true }
const mainSteps: MainStep[] = []
const judgeCalls: StubCall[] = []
let nudgeRecorded = Promise.withResolvers<void>()

function nudgeAccepted(body: ChatBody): boolean {
  return body.messages.some((message) => message.role === "tool" && textOf(message.content).startsWith("recorded: "))
}

async function untilNudgeRecorded(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the recall judge recorded no nudge within ${NUDGE_WAIT_MS} ms`)), NUDGE_WAIT_MS)
  })
  try {
    await Promise.race([nudgeRecorded.promise, expired])
  } finally {
    clearTimeout(timer)
  }
}

const provider = startStubProvider(async (body): Promise<StubReply> => {
  if (systemText(body).includes(JUDGE_PERSONA)) {
    if (nudgeAccepted(body)) nudgeRecorded.resolve()
    const next = judgeCalls.shift()
    return next === undefined ? { text: "no nudge" } : { call: next }
  }
  const step = mainSteps.shift()
  if (step === undefined) return { text: "done" }
  if (step.afterNudge === true) await untilNudgeRecorded()
  return { call: step.call }
})

let box: Sandbox

function judgeSessions(): string[] {
  const requests = box.probe().filter((entry): entry is ProbeRequest => entry.kind === "request" && entry.agent === RECALL_AGENT)
  return [...new Set(requests.map((entry) => entry.sessionID))]
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
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
  test("a nudge the judge records mid-turn reaches the next tool result once, outside the system prompt", async () => {
    const session = newSessionID()
    judgeCalls.push({ name: "recall_nudge", args: { path: FREEZE, hint: FREEZE_HINT } })
    mainSteps.push({ call: READ }, { call: READ, afterNudge: true })
    await box.run(session, "Schedule the payments deploy for Friday afternoon", { model: MODEL })

    const judges = judgeSessions()
    expect(judges).toHaveLength(1)
    const judge = judges[0] ?? ""
    const first = box.requests(judge)[0]
    if (first === undefined) throw new Error("the recall judge made no request")
    const envelope = lastUserText(first)
    expect(envelope).toContain('<recall-request max-items="2">')
    expect(envelope).toContain("<task>Schedule the payments deploy for Friday afternoon</task>")
    expect(envelope).toContain(`<candidate path="${FREEZE}" description="payments deploy freeze on fridays">`)
    expect(envelope).not.toContain(TRAIN)
    expect(envelope).not.toContain(COFFEE)
    expect(systemText(first)).toContain(JUDGE_PERSONA)
    expect(systemText(first)).not.toContain("<memory_metadata>")
    expect(toolNames(first)).toEqual(["recall_nudge"])

    const requests = box.requests(session)
    const carrying = toolExchanges(requests)
      .filter((exchange) => exchange.name === "read")
      .map((exchange) => exchange.result ?? "")
      .filter((result) => result.includes(`<recalled-memory source="[[${FREEZE}]]">`))
    expect(carrying).toHaveLength(1)
    expect(carrying[0]).toContain(HEADER)
    expect(carrying[0]).toContain(FREEZE_HINT)
    for (const body of requests) expect(toolNames(body)).not.toContain("recall_nudge")
    expect(new Set(requests.map(systemText)).size).toBe(1)
    expect(systemText(requests[0] ?? { model: "", messages: [] })).toContain("Relevant stored memory may arrive on its own as <recalled-memory> blocks")
    expect(systemText(requests[0] ?? { model: "", messages: [] })).not.toContain("<recalled-memory source=")
    await waitFor("the finished judge session to be removed", () => box.api("session.get", { sessionID: judge }).then(() => undefined, () => true), 30_000)
  })

  test("a nudge recorded after the turn ends rides on the next user message, after one refused instruction-shaped hint", async () => {
    const session = newSessionID()
    const before = judgeSessions().length
    nudgeRecorded = Promise.withResolvers<void>()
    judgeCalls.push({ name: "recall_nudge", args: { path: TRAIN, hint: "Check the release train cutoff before tagging." } }, { name: "recall_nudge", args: { path: TRAIN, hint: TRAIN_HINT } })
    await box.run(session, "When is the release train cutoff for the next tag?", { model: MODEL })
    const judge = await waitFor("a judge for the release-train prompt", () => judgeSessions()[before], 60_000)
    await untilNudgeRecorded()
    await waitFor(
      "the judge run to finish",
      () => (box.probe().some((entry) => entry.kind === "event" && entry.type === "session.execution.succeeded" && entry.sessionID === judge) ? true : undefined),
      60_000,
    )

    const exchanges = toolExchanges(box.requests(judge))
    expect(exchanges.map((exchange) => exchange.name)).toEqual(["recall_nudge", "recall_nudge"])
    expect(exchanges[0]?.result).toContain("the hint is an instruction")
    expect(exchanges[1]?.result).toContain(`recorded: ${TRAIN}`)
    expect(occurrences(lastUserText(box.lastRequest(session)), "<recalled-memory")).toBe(0)

    await box.run(session, "say ok", { model: MODEL })
    const carried = lastUserText(box.lastRequest(session))
    expect(occurrences(carried, `<recalled-memory source="[[${TRAIN}]]">`)).toBe(1)
    expect(carried).toContain(TRAIN_HINT)

    await box.run(session, "When is the release train cutoff again?", { model: MODEL })
    expect(judgeSessions()).toHaveLength(before + 1)
    const transcript = box
      .lastRequest(session)
      .messages.map((message) => textOf(message.content))
      .join("\n")
    expect(occurrences(transcript, `<recalled-memory source="[[${TRAIN}]]">`)).toBe(1)
  })
})
