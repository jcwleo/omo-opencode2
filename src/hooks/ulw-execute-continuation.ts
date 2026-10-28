import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { getPlanChecklist, getWorkForSession, resolveBoulderPlanPathForWork } from "../omo/core.generated.js"
import { omoLogger } from "../omo/shared.ts"

// Ported from omo-senpi's ulw-execute-continuation: same cap, same dedupe signature, same directive.
const CONTINUATION_LIMIT = 8
const CONTINUATION_SOURCE = "omo-ulw-execute-continuation"
export const SESSION_ID_PREFIX = "opencode2:"

type SessionState = { consecutive: number; signature?: string; resumeLock?: boolean }

function renderDirective(input: {
  planName: string
  planPath: string
  boulderPath: string
  ledgerPath: string
  checklist: { completed: number; remaining: number; total: number; nextTaskLabel: string | null }
  worktreePath: string | null
  sessionId: string
}): string {
  const worktreeBlock = input.worktreePath === null ? "" : `\n- Worktree: \`${input.worktreePath}\` (all edits, tests, and commands run inside this directory)`
  const nextLabel = input.checklist.nextTaskLabel ?? "none (final gate pending)"
  const finalGateHint =
    input.checklist.remaining === 0 ? "\nAll top-level checkboxes are complete. Run the Final Verification Wave and mark the boulder work completed." : ""
  return [
    "<omo-ulw-execute-continuation>",
    "You are mid-flight on a ulw-execute work plan; this turn is an automatic continuation. Do NOT ask whether to continue: the contract is auto-continue until every top-level checkbox is `- [x]`.",
    "",
    "# State",
    "",
    `- Plan: \`${input.planName}\``,
    `- Plan file: \`${input.planPath}\``,
    `- Boulder state: \`${input.boulderPath}\``,
    `- Remaining top-level checkboxes: ${input.checklist.remaining} of ${input.checklist.total}`,
    `- [Status: ${input.checklist.completed}/${input.checklist.total}, next: ${nextLabel}]`,
    `- Ledger: \`${input.ledgerPath}\``,
    `- Your session id in boulder.json: ${input.sessionId}`,
    `${worktreeBlock}`,
    "",
    "# What to do this turn",
    "",
    "1. Read the plan file AND the ledger first: they are the only sources of truth for what remains and what evidence exists; do not trust your memory of prior turns.",
    `2. When the remaining count is \`0\`, skip checkbox execution and perform the Final gate now. Otherwise, pick the FIRST unchecked top-level checkbox in \`## TODOs\` or \`## Final Verification Wave\`.${finalGateHint}`,
    "3. Apply the checkbox's tier and verify with real-surface evidence. Decompose and dispatch sub-tasks in parallel through the `subagent` tool when safe.",
    "4. Honor the delivery mode recorded in the goal/ledger at session start: `--make-pr` finishes through the task-owned worktree and an opened PR, then hands off with the PR URL; `--ship` keeps working until that PR is MERGED, then removes the worktree and syncs `.omo/` state back.",
    "5. After verification, apply the checkbox, append a durable evidence record to the ledger, and continue.",
    "</omo-ulw-execute-continuation>",
  ].join("\n")
}

export async function registerUlwExecuteContinuation(ctx: Plugin.Context): Promise<() => void> {
  const directory = ctx.location.directory
  const sessions = new Map<string, SessionState>()
  const stateFor = (sessionID: string): SessionState => {
    const existing = sessions.get(sessionID)
    if (existing !== undefined) return existing
    const created: SessionState = { consecutive: 0 }
    sessions.set(sessionID, created)
    return created
  }

  await ctx.session.hook("prompt", (event) => {
    if (event.metadata?.source === CONTINUATION_SOURCE) return
    const state = stateFor(event.sessionID)
    state.consecutive = 0
    state.signature = undefined
  })

  const continueIfPlanned = async (sessionID: string): Promise<void> => {
    const state = stateFor(sessionID)
    if (state.resumeLock === true) return
    if (state.consecutive >= CONTINUATION_LIMIT) return
    const session = await ctx.session.get({ sessionID })
    if (session.parentID !== undefined) return
    const boulderId = `${SESSION_ID_PREFIX}${sessionID}`
    const work = getWorkForSession(directory, boulderId)
    if (work === null || (work.status !== undefined && work.status !== "active" && work.status !== "paused")) {
      state.signature = undefined
      return
    }
    const planPath = resolveBoulderPlanPathForWork(directory, work)
    const checklist = getPlanChecklist(planPath)
    if (checklist.total <= 0) return
    const signature = `${work.work_id}:${work.updated_at ?? work.started_at}:${checklist.completed}/${checklist.total}`
    if (state.signature === signature) return
    state.signature = signature
    state.consecutive += 1
    state.resumeLock = true
    try {
      await ctx.session.synthetic({
        sessionID,
        text: renderDirective({
          planName: work.plan_name,
          planPath,
          boulderPath: join(directory, ".omo", "boulder.json"),
          ledgerPath: join(directory, ".omo", "ulw-execute", "ledger.jsonl"),
          checklist,
          worktreePath: work.worktree_path ?? null,
          sessionId: boulderId,
        }),
        description: "ulw-execute continuation",
        metadata: { source: CONTINUATION_SOURCE },
        resume: true,
      })
    } finally {
      state.resumeLock = false
    }
  }

  const controller = new AbortController()
  void (async () => {
    // OpenCode 2.1.4 ends a run with `session.execution.succeeded` (or `failed`/`interrupted`) and emits no
    // `session.idle`, so only a run that finished cleanly is continued.
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type !== "session.execution.succeeded") continue
      await continueIfPlanned(event.data.sessionID).catch((error: unknown) => omoLogger.warn("ulw-execute continuation failed", error))
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) omoLogger.warn("ulw-execute continuation subscription stopped", error)
  })
  return () => controller.abort()
}
