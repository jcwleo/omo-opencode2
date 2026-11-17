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
const TRAIN_EVIDENCE = "The &quot;release train&quot; leaves every Tuesday at 10:00 KST; the cutoff is Monday 18:00 KST."
const COFFEE = "notes/coffee.md"
const TOOLCHAIN = "reference/toolchain.md"
const TOOLCHAIN_LINE = "ruff format rewrites whole files and broke the parser module once; format only the changed lines."
const TOOLCHAIN_HINT = "The toolchain note records that ruff format rewrote whole files and broke the parser module once."
const RUFF = "echo ruff format src/parser.py"
const PARSER = "reference/parser-module.md"
const PARSER_LINE = "src/parser.py is generated from grammar/parser.peg; hand edits are lost on the next build."
const PARSER_HINT = "The parser note records that src/parser.py is generated from grammar/parser.peg, so hand edits are lost on the next build."
const STYLE = "reference/python-style.md"
const LEDGER = "notes/facts/2026-10.md"
const FACT_DB = "The staging database moved to db-stg-02; the old host only serves read replicas."
const FACT_EXPORT = "Nightly exports run at 02:00 KST and lock the orders table for about ten minutes."
const DB_HINT = "The ledger records that the staging database moved to db-stg-02 and the old host only serves read replicas."
const EXPORT_HINT = "The ledger records that nightly exports run at 02:00 KST and lock the orders table for about ten minutes."

type MainStep = { readonly call: StubCall; readonly afterSurfaced?: string }
const mainSteps: MainStep[] = []
const judgeReplies: string[] = []
const toolJudgeReplies: string[] = []
let box: Sandbox

const provider = startStubProvider(async (body): Promise<StubReply> => {
  if (lastUserText(body).includes('<tool-call tool="')) return { text: toolJudgeReplies.shift() ?? SILENT }
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

type JudgeRecord = { judge: string; trigger: string; outcome: string; calls: number; searched: string[]; proposed: { path: string; outcome: string; reason?: string }[] }
type DeliveryRecord = { path: string; via: string; afterMs: number }

function logged<T>(kind: "judge" | "delivered"): T[] {
  return box.serverLog().split("\n").flatMap((line) => {
    const json = new RegExp(`memory recall ${kind} (\\{.*\\})`).exec(line)?.[1]
    return json === undefined ? [] : [JSON.parse(json) as T]
  })
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
    { file_path: TRAIN, description: "release train cadence and cutoff", file_text: 'The "release train" leaves every Tuesday at 10:00 KST; the cutoff is Monday 18:00 KST.\n' },
    { file_path: TOOLCHAIN, description: "python formatter hazards", file_text: `- ${TOOLCHAIN_LINE}\n\n<!-- recall-triggers\ncommands: ruff format\n-->\n` },
    { file_path: PARSER, description: "parser module ownership", file_text: `- ${PARSER_LINE}\n\n<!-- recall-triggers\npaths: **/parser.py, grammar/parser.peg\n-->\n` },
    { file_path: STYLE, description: "python style rules", file_text: "- Run ruff format on src/parser.py and every other module before committing.\n\n<!-- recall-triggers\ncommands: pytest, python -m pytest\npaths: **/*.py, src/**\n-->\n" },
    { file_path: LEDGER, description: "Explicit facts for 2026-10", file_text: `- [2026-10-02] ${FACT_DB}\n- [2026-10-05] ${FACT_EXPORT}\n` },
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
    judgeReplies.push('{"search":["payments","deploy","friday","금요일"],"nudges":[]}', JSON.stringify({ search: [], nudges: [{ path: FREEZE, evidence: "Deploys of the payments service are frozen on Fridays since the 2026-10-03…", hint: FREEZE_HINT }] }))
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
    for (const body of [first, final]) expect(toolNames(body)).toEqual([])
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
    const record = await waitFor("the judge's log line", () => logged<JudgeRecord>("judge").find((line) => line.judge === judge), 30_000)
    expect(record).toMatchObject({ trigger: "prompt", outcome: "judged", calls: 2, proposed: [{ path: FREEZE, outcome: "accepted" }] })
    expect(record.searched).toContain(FREEZE)
    const delivered = await waitFor("the delivery log line", () => logged<DeliveryRecord>("delivered").find((line) => line.path === FREEZE), 30_000)
    expect(delivered.via).toBe("tool-result")
    expect(delivered.afterMs).toBeGreaterThanOrEqual(0)
  })

  test("a nudge surfaced after the turn ends rides on the next user message; instruction hints, invented evidence, approvals and delivered notes are skipped", async () => {
    const session = newSessionID()
    const before = judgeSessions().length
    judgeReplies.push(
      JSON.stringify({
        search: [],
        nudges: [
          { path: TRAIN, evidence: TRAIN_EVIDENCE, hint: "Check the release train cutoff before tagging." },
          { path: TRAIN, evidence: "The release train leaves every Monday at 09:00 KST", hint: "The release-train note records that the train leaves Mondays at 09:00 KST." },
          { path: TRAIN, evidence: TRAIN_EVIDENCE, hint: TRAIN_HINT },
        ],
      }),
    )
    await box.run(session, "When is the release train cutoff for the next tag?", { model: MODEL })
    await waitFor(`the judge to surface ${TRAIN}`, () => (box.serverLog().includes(`memory recall surfaced ${TRAIN}`) ? true : undefined), 60_000)
    expect(occurrences(lastUserText(box.lastRequest(session)), "<recalled-memory")).toBe(0)

    await box.run(session, "ok", { model: MODEL })
    const carried = lastUserText(box.lastRequest(session))
    expect(occurrences(carried, `<recalled-memory source="[[${TRAIN}]]">`)).toBe(1)
    expect(carried).toContain(TRAIN_HINT)
    expect(carried).not.toContain("Check the release train cutoff")
    expect(carried).not.toContain("Mondays at 09:00")
    expect(judgeSessions()).toHaveLength(before + 1)
    const firstJudge = judgeSessions()[before] ?? ""
    const record = await waitFor("the judge's log line", () => logged<JudgeRecord>("judge").find((line) => line.judge === firstJudge), 30_000)
    expect(record.calls).toBe(1)
    expect(record.proposed.map((proposal) => proposal.outcome)).toEqual(["bad-hint", "no-evidence", "accepted"])
    expect(record.proposed[0]?.reason).toContain("instruction")
    expect(logged<DeliveryRecord>("delivered").filter((line) => line.path === TRAIN).map((line) => line.via)).toEqual(["user-message"])

    await box.run(session, "When is the release train cutoff again?", { model: MODEL })
    const judge = await waitFor("a judge for the follow-up prompt", () => judgeSessions()[before + 1], 60_000)
    const envelope = await waitFor("the follow-up judge's request", () => box.requests(judge, "generate")[0], 60_000)
    expect(lastUserText(envelope)).not.toContain(`- ${TRAIN} ::`)
    expect(lastUserText(envelope)).toContain(`<delivered>\n${TRAIN}: ${TRAIN_HINT}\n</delivered>`)
    expect(lastUserText(envelope)).toContain(`- ${FREEZE} ::`)
    const requests = box.requests(session)
    expectNoSubagentTurn(requests)
    const transcript = box
      .lastRequest(session)
      .messages.map((message) => textOf(message.content))
      .join("\n")
    expect(occurrences(transcript, `<recalled-memory source="[[${TRAIN}]]">`)).toBe(1)
  })

  test("a tool call that matches a note's recall triggers starts one single-pass judge; broad triggers and plain word overlap do not", async () => {
    const session = newSessionID()
    const toolJudges = (): ChatBody[] => judgeSessions().flatMap((id) => box.requests(id, "generate")).filter((body) => lastUserText(body).includes('<tool-call tool="'))
    const results = (body: ChatBody | undefined): string => {
      const text = lastUserText(body ?? { model: "", messages: [] })
      return text.slice(text.indexOf('<search-results terms="'))
    }
    const before = toolJudges().length
    toolJudgeReplies.push(
      JSON.stringify({ search: [], nudges: [{ path: PARSER, evidence: PARSER_LINE, hint: PARSER_HINT }] }),
      JSON.stringify({ search: [], nudges: [{ path: TOOLCHAIN, evidence: TOOLCHAIN_LINE, hint: TOOLCHAIN_HINT }] }),
    )
    const shell = (command: string): StubCall => ({ name: "shell", args: { command } })
    mainSteps.push(
      { call: shell("echo hello there") },
      { call: { name: "read", args: { path: "src/parser.py" } } },
      { call: shell(RUFF), afterSurfaced: PARSER },
      { call: READ, afterSurfaced: TOOLCHAIN },
      { call: shell(RUFF) },
    )
    await box.run(session, "Tidy up the parser module", { model: MODEL })

    const calls = toolJudges().slice(before)
    expect(calls).toHaveLength(2)
    const [onRead, onRuff] = calls
    expect(lastUserText(onRead ?? { model: "", messages: [] })).toContain('<tool-call tool="read">src/parser.py</tool-call>')
    expect(results(onRead)).toContain(`${PARSER} (matched trigger: **/parser.py)`)
    expect(results(onRead)).toContain("grammar/parser.peg")
    expect(results(onRead)).not.toContain(STYLE)
    expect(results(onRead)).not.toContain(TOOLCHAIN)
    expect(lastUserText(onRuff ?? { model: "", messages: [] })).toContain(`<tool-call tool="shell">${RUFF}</tool-call>`)
    expect(lastUserText(onRuff ?? { model: "", messages: [] })).toContain("<task>Tidy up the parser module</task>")
    expect(results(onRuff)).toContain(`${TOOLCHAIN} (matched trigger: ruff format)`)
    expect(results(onRuff)).toContain("ruff format rewrites whole files")
    expect(results(onRuff)).not.toContain(PARSER)
    expect(results(onRuff)).not.toContain(STYLE)
    for (const body of calls) expect(lastUserText(body)).not.toContain("recall-triggers")
    const requests = box.requests(session)
    expect(toolExchanges(requests).filter((exchange) => exchange.name === "shell")).toHaveLength(3)
    const carrying = (path: string): string[] =>
      toolExchanges(requests)
        .map((exchange) => exchange.result ?? "")
        .filter((result) => result.includes(`<recalled-memory source="[[${path}]]">`))
    expect(carrying(PARSER)).toHaveLength(1)
    expect(carrying(TOOLCHAIN)).toHaveLength(1)
    expect(carrying(TOOLCHAIN)[0]).toContain(TOOLCHAIN_HINT)
    expectNoSubagentTurn(requests)
  })

  test("a fact ledger stays on offer after a delivery and surfaces each fact once", async () => {
    const session = newSessionID()
    const surfacedLedger = (): number => occurrences(box.serverLog(), `memory recall surfaced ${LEDGER}`)
    const before = surfacedLedger()
    judgeReplies.push(JSON.stringify({ search: [], nudges: [{ path: LEDGER, evidence: `- [2026-10-02] ${FACT_DB}`, hint: DB_HINT }] }))
    await box.run(session, "Point the staging migration at the right database host", { model: MODEL })
    await waitFor("the first ledger fact", () => (surfacedLedger() >= before + 1 ? true : undefined), 60_000)

    judgeReplies.push(JSON.stringify({ search: [], nudges: [{ path: LEDGER, evidence: FACT_DB, hint: DB_HINT }, { path: LEDGER, evidence: FACT_EXPORT, hint: EXPORT_HINT }] }))
    await box.run(session, "When do the nightly exports lock the orders table?", { model: MODEL })
    await waitFor("the second ledger fact", () => (surfacedLedger() >= before + 2 ? true : undefined), 60_000)
    const judge = judgeSessions().at(-1) ?? ""
    const envelope = lastUserText(await waitFor("the second ledger judge's request", () => box.requests(judge, "generate")[0], 60_000))
    expect(envelope).toContain(`- ${LEDGER} :: Explicit facts for 2026-10`)
    expect(envelope).toContain(`<delivered>\n${LEDGER}: ${DB_HINT}\n</delivered>`)

    await box.run(session, "ok", { model: MODEL })
    const transcript = box
      .lastRequest(session)
      .messages.map((message) => textOf(message.content))
      .join("\n")
    expect(occurrences(transcript, DB_HINT)).toBe(1)
    expect(occurrences(transcript, EXPORT_HINT)).toBe(1)
    expect(surfacedLedger()).toBe(before + 2)
  })
})
