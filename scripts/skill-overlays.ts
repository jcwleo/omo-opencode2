// Rewrites of Senpi-specific passages, applied after the copy. `file` is relative to skills/.
// A `replace` overlay must match exactly `count` times (default 1) and a `section` overlay must find
// its heading, so an upstream change that moves the text fails the sync instead of passing silently.

export type Overlay =
  | { readonly file: string; readonly replace: string; readonly with: string; readonly count?: number }
  | { readonly file: string; readonly section: string; readonly with: string }

const SUBAGENT_LANES =
  "`omo/quick`, `omo/unspecified-low`, `omo/unspecified-high`, `omo/deep-low`, `omo/deep-high`, `omo/ultrabrain`, `omo/visual-engineering`, `omo/writing`, `omo/artistry`, `omo/architect`"

const REVIEW_POLICY = `## Review Policy (authoritative)

In OpenCode 2 the high-accuracy review is PLAN-REVIEWER-ONLY: one round is exactly ONE \`omo/plan-reviewer\` subagent review of the complete plan file, and a plan-reviewer approval whose remaining items are notes counts as approval. High-accuracy plan-reviewer review is the default for every plan this skill produces (CLEAR and UNCLEAR alike); the only opt-out is the user explicitly declining. It runs until unconditional approval while each round raises a new blocker-eligible finding or closes a ledger blocker, and stops on a round that does neither and still does not approve (see Bounded convergence).

Only a plan file produced by this skill and recorded with \`review_required\` authorizes an \`omo/plan-reviewer\` or \`omo/plan-consultant\` review. A bare \`ulw\` run without that file uses notepad self-review instead, however large the work feels. Narrow \`/ulw-execute\` bootstrap exception: when \`/ulw-execute\` invoked this skill because there was no selectable plan, do not call \`omo/plan-consultant\` or \`omo/plan-reviewer\`; the bootstrap flow generates the plan WITHOUT plan-consultant gap analysis or plan-reviewer review. State this exception explicitly, recommending a follow-up ulw-plan review session if rigor is needed.

If a section below conflicts with this section, this section wins.

`

export const SKILL_OVERLAYS: readonly Overlay[] = [
  { file: "ultrawork/SKILL.md", replace: "HTTP client from js eval)", with: "HTTP client script run through `shell`)" },
  { file: "ultrawork/SKILL.md", replace: "drive the REAL page from the eval js kernel with", with: "drive the REAL page from a Bun script run through `shell` with" },
  {
    file: "ultrawork/SKILL.md",
    replace: "eval cell, with parallel lookups covering the code, git history of paths\nto touch, memory, and prior session evidence.",
    with: "batch of parallel tool calls covering the code, git history of paths\nto touch, memory, and prior session evidence.",
  },
  { file: "ultrawork/SKILL.md", replace: "execution` below - one js eval cell;", with: "execution` below - one batch of parallel tool calls;" },
  {
    file: "ultrawork/SKILL.md",
    replace: "the built-in `lsp_*` tools, not\n   text search.",
    with: "the `lsp_*` tools from the plugin's `lsp` MCP server, not\n   text search.",
  },
  {
    file: "ultrawork/SKILL.md",
    section: "# Parallel execution (batch what is independent, observe what is not)",
    with: `# Parallel execution (batch what is independent, observe what is not)
**Send the independent part of a step - reads, searches, symbol lookups,
git and web queries, \`subagent\` spawns - as several tool calls in ONE
response, not a parade of one-off turns.** When your tools run through
an \`execute\` script (OpenCode's Code Mode), put those independent calls
in one script and await them together (\`Promise.all\`) with real control
flow - \`if\`/\`else\` per case, a loop over every target, a \`try\`/\`catch\`
per item. Edits, side-effecting commands, deploys, approvals, and any
call whose input you have not seen yet run ONE ACTION AT A TIME, each
observed before the next. Before a batch runs, name the state it should
produce; when it returns, compare the returned evidence with that state,
and check a mutating step for changes beyond it. Keep every failed or
missing item verbatim - a \`catch\` that turns a failure into an absent row
makes the aggregate lie - and re-read truncated output before deciding on
it. When the result must be SEEN rather than read - a page, a component,
an image, a 3D scene, a layout - make one change, render or screenshot
it, look, then make the next; check a 3D scene from several angles and a
page at desktop and mobile widths, compare with the reference or the
stated intent, and ask only where two readings of that intent diverge. A
command that can outlive one reply runs through \`shell\` with
\`background: true\` (Waiting discipline). Spawn independent \`subagent\`
children in the same wave (\`background: true\`, each routed to its fitting
\`omo/<category>\` lane); fan-out is SAFE only with disjoint write scopes -
no two children edit the same files; overlapping units run in sequence or
in separate worktrees. Keep for yourself what needs your judgment.

`,
  },
  {
    file: "ultrawork/SKILL.md",
    section: "# Waiting discipline (subscribe, never sleep)",
    with: `# Waiting discipline (notify, never sleep)
**EVERY CONDITION YOU WOULD OTHERWISE CHECK ON GETS A BACKGROUND RUN
THAT NOTIFIES YOU: \`shell\` with \`background: true\` for a build, install,
or test run, and a gate command (\`until <cond>; do sleep 5; done\`) with
\`background: true\` for a condition** - a CI check or PR turning green, a
deploy landing, a log line, a file appearing, a port opening, another
session or a remote machine changing state. Its completion arrives as a
notification while you keep working, and a background \`subagent\` child
completes the same way. The background run is the whole cost of a wait:
a foreground \`sleep\`, timed retries, re-polls, a foreground call that
sits on a \`--watch\` or a spawned process, and a child spawned to watch
are FORBIDDEN - each replays the whole context through the model. Once
the background run is started, do root work or end the turn; the
notification wakes you.
**START WATCHES FROM THE USER'S INTENT, UNPROMPTED.** When the user
names any such state, work out what they will want next and watch it
RIGHT THEN: "check the deploy" = a gate on its status, "I pushed a fix" =
a gate on that CI run, "the other session is doing X" = a gate on its
output. A session without watches while state moves around it is asleep.
Read a running command's output ONLY for a midpoint decision, never to
wait.

`,
  },
  {
    file: "ultrawork/SKILL.md",
    section: "# omo-senpi task + team tools",
    with: `# OpenCode 2 subagent tool
Delegate through the \`subagent\` tool: \`agent\`, \`description\`, \`prompt\`.
\`agent\` is a category lane (${SUBAGENT_LANES}) or a curated agent
(\`omo/explore\`, \`omo/librarian\`, \`omo/plan-consultant\`,
\`omo/plan-reviewer\`, and the reviewers \`omo/code-reviewer\`,
\`omo/qa-executor\`, \`omo/gate-reviewer\`). \`background: true\` runs a
parallel wave and notifies you when each child finishes; pass a child's
returned \`sessionID\` again to steer or continue it. A child starts with
fresh context, so its prompt carries every fact it needs and names the
skills it should load with the \`skill\` tool. Curated agents are
read-only. OpenCode 2 has no team tools: for cooperating parallel work,
run each member as a background subagent, relay findings between members
yourself through \`sessionID\` follow-ups, and keep shared state in a file.

`,
  },
  {
    file: "ultrawork/SKILL.md",
    replace: "The todo tool is senpi `todo` — your live, user-visible checklist.",
    with: "When `todowrite` is listed (OpenCode 2 turns it on with the `experimental.todo` setting), it is your live, user-visible checklist: it replaces the whole list, each item with a status, so read the verbs below as `todowrite` updates. Otherwise the todo list is the notepad's `## Todo` section, and you restate its open items to the user at each handoff:",
  },
  {
    file: "hyperplan/SKILL.md",
    section: "## HOW THIS MAPS TO omo-senpi",
    with: `## HOW THIS MAPS TO OPENCODE 2

OpenCode 2 has no team tools. Each member is a background child session started with the \`subagent\` tool on a category lane, and you coordinate every member with that one tool. Where the phases below show \`team_create\`, \`task_send\`, or \`team_delete\`, do what this table says:

| Purpose | How | Key arguments |
|---------|-----|---------------|
| Start each member (replaces \`team_create\`) | \`subagent\` | \`agent: "omo/<category>"\`, \`description\`, \`prompt\` = the member's identity prompt plus round 1, \`background: true\`; record the returned \`sessionID\` per member |
| Send a later round (replaces \`task_send\`) | \`subagent\` | that member's \`sessionID\`, \`prompt\` = the round task plus the bundle you forward, \`background: true\` |
| Collect member replies | completion notices | each background run notifies you when it finishes; its final message is the member's reply |
| Hand off to the planner | \`subagent\` | \`agent: "omo/ultrabrain"\` (or your strongest reasoning lane), foreground; the prompt tells it to load the \`ulw-plan\` skill with the \`skill\` tool |
| Disband the team (replaces \`team_delete\`) | nothing to call | a member session simply receives no further rounds |

You are the information broker — members never see each other's replies except through the bundles you forward.

**Delivery is notification-driven.** A background \`subagent\` call returns immediately. After sending round N to all members, keep doing independent lead work or end your turn; each reply arrives as a completion notice, and the round is complete once every expected reply has arrived.

`,
  },
  {
    file: "hyperplan/SKILL.md",
    replace: `1. **The lead team tools must be available** — \`team_create\`, \`task_send\`, \`team_delete\`. They register by default with the task component. If they are absent, the task component was disabled; STOP and tell the user:
   > "Hyperplan needs the omo-senpi team tools, which are disabled. Restart without \`--no-omo-task\` (\`omo\` on OmO Native, \`senpi\` on a plain senpi install; the task component is on by default), then retry."
2. **You are the current top-level lead session** — the team tools are lead-only and never reach a child. If you are yourself a spawned member/child, this skill is the wrong tool; a member cannot lead a team.`,
    with: `1. **The omo category lanes must be available** — the \`subagent\` tool lists \`omo/unspecified-low\`, \`omo/unspecified-high\`, \`omo/ultrabrain\`, and \`omo/artistry\`. If they are absent, the omo agents are not installed; STOP and tell the user:
   > "Hyperplan needs the omo category agents. Run \`bun run install:agents\` in omo-opencode2, then retry."
2. **You are the current top-level session** — a subagent child cannot start subagents of its own. If you are yourself a spawned member/child, this skill is the wrong tool; a member cannot lead a team.`,
  },
  {
    file: "hyperplan/SKILL.md",
    replace:
      'Each member is a `kind: "category"` team member. The category selects the member\'s model and prompt shaping; the `prompt` field below is the **system prompt** that establishes its adversarial identity.',
    with: "Each member is a background subagent on a category lane (`omo/<category>`). The lane selects the member's model and prompt shaping; send the `prompt` field below as the opening of the member's first message, where it establishes its adversarial identity.",
  },
  {
    file: "hyperplan/SKILL.md",
    replace: "(or a planner agent your `omo.json` defines via `subagent_type`)",
    with: "(or a planner agent you defined in OpenCode's `agents` config)",
  },
  {
    file: "ulw-research/SKILL.md",
    section: "## How this maps to omo-senpi",
    with: `## How this maps to OpenCode 2

OpenCode 2 has no team tools, so the research team is a set of background subagents you broker. Where the phases below show \`team_create\`, \`task_send\`, the team tasklist, \`task_output\`, or \`team_delete\`, do what this table says:

| Purpose | How | Key arguments |
|---------|-----|---------------|
| Stand up each research member (replaces \`team_create\`) | \`subagent\` | \`agent: "omo/<category>"\`, \`description\`, \`prompt\` = the member brief, \`background: true\`; record each member's \`sessionID\` in \`$SESSION_DIR/state.md\` |
| Send work / a lead / a debate round to a member (replaces \`task_send\`) | \`subagent\` | that member's \`sessionID\`, \`prompt\`, \`background: true\` |
| Collect member replies | completion notices | each background run notifies you when it finishes |
| Track shared research state (replaces the team tasklist) | \`$SESSION_DIR/state.md\` | one row per axis and major lead, with owner and status, kept current |
| Spawn a bounded recon / expansion / verification lane | \`subagent\` | \`agent: "omo/explore"\` or \`"omo/librarian"\` or a category lane, \`background: true\`; name the skills the lane should load in its prompt |
| Read a finished lane back (replaces \`task_output\`) | the completion notice | the lane's final message |
| Disband the team at the end (replaces \`team_delete\`) | nothing to call | members simply receive no further work |

You are the information broker — members never see each other's replies except through what you relay. The curated agents (\`omo/explore\`, \`omo/librarian\`, \`omo/plan-consultant\`, \`omo/plan-reviewer\`) are read-only: use them as lanes, not as members that must write.

`,
  },
  {
    file: "ulw-research/SKILL.md",
    replace:
      "ulw-loop is ON by default for this mode: register the research axes as loop goals from a JS eval cell (import the SDK once, const { agentToolkit } = await import(`${env(\"OMO_AGENT_TOOLKIT_SDK_ROOT\")}/sdk.js`), then `agentToolkit.createGoals({ brief })`, then `create_goal` from the returned handoff) so the run has durable state and survives a compaction.",
    with: "OpenCode 2 has no ulw-loop, so the run's durable state is `$SESSION_DIR/state.md`: every axis, its owner, and its status, updated as they change, so the run survives a compaction.",
  },
  {
    file: "ulw-research/SKILL.md",
    replace: "re-read the brief, the journal, and `agentToolkit.status()` (re-import the SDK if the kernel restarted) before doing anything else",
    with: "re-read the brief, the journal, and `state.md` before doing anything else",
  },
  {
    file: "ulw-research/SKILL.md",
    replace:
      "every category your `omo.json` defines (`quick`, `unspecified-low`, `unspecified-high`, `deep`, `ultrabrain`, `architect`, `writing`, `artistry`, ...) and every non-curated `subagent_type`",
    with: `every category lane the \`subagent\` tool lists (${SUBAGENT_LANES}) and every other non-curated agent`,
  },
  {
    file: "ulw-research/SKILL.md",
    replace:
      "A category member must also carry its brief as `prompt` (the runtime requires both), and a `subagent_type` member must name a non-curated agent — a member with neither is rejected at parse. NEVER name a curated agent (`explore`, `librarian`, `plan-consultant`, `plan-reviewer`) as a member — the runtime rejects them; they run as `task` lanes instead.",
    with: "Every member's first prompt carries its brief. NEVER make a curated agent (`omo/explore`, `omo/librarian`, `omo/plan-consultant`, `omo/plan-reviewer`) a member — they are read-only and run as recon lanes instead.",
  },
  {
    file: "ulw-research/SKILL.md",
    replace:
      '(`agentToolkit.steer({ kind: "add_subgoal", source: "finding", title: "<axis>", objective: "<what it must answer>", evidence: "<what surfaced it>", rationale: "<why the plan changes>" })`)',
    with: "(add it to `state.md` with its owner and what surfaced it)",
  },
  {
    file: "ulw-research/SKILL.md",
    replace:
      'then mirror the whole excursion into the loop ledger: `agentToolkit.steer({ kind: "annotate_ledger", source: "finding", evidence: "<what the excursion observed>", rationale: "<what it changed, or none>" })`, and when it settled a success criterion, `agentToolkit.recordEvidence({ goalId, criterionId, status: "pass", evidence: "<artifact>" })`. Use status `"fail"` or `"blocked"` instead when the evidence supports that outcome. After a compaction, `agentToolkit.status()` plus `excursion-log.md` tell you which excursions are still open.',
    with: "then record the excursion in `state.md`: what it observed, what it changed (or none), and, when it settled a success criterion, that criterion's status (`pass`, `fail`, or `blocked`) with its evidence artifact. After a compaction, `state.md` plus `excursion-log.md` tell you which excursions are still open.",
  },
  { file: "ulw-plan/SKILL.md", replace: "(plan-reviewer-only in omo-senpi)", with: "(plan-reviewer-only)" },
  { file: "ulw-plan/SKILL.md", section: "## Senpi Review Policy (authoritative)", with: REVIEW_POLICY },
  { file: "ulw-plan/references/full-workflow.md", section: "## Senpi Review Policy (authoritative)", with: REVIEW_POLICY },
  {
    file: "ulw-plan/SKILL.md",
    section: "## Senpi Design Consultation Lanes (authoritative)",
    with: `## Design Consultation Lanes (authoritative)

When the \`subagent\` tool lists \`omo/architect\` and/or \`omo/ultrabrain\`, ACTIVELY consult them as background advisory lanes while grounding and drafting the plan:

| Lane | Agent | Ask it for |
| --- | --- | --- |
| Big-picture design | \`omo/architect\` | module boundaries, decomposition options, trade-offs, blast radius |
| Detail design | \`omo/ultrabrain\` | algorithms, edge cases, exact interfaces and contracts |

Spawn them with \`subagent\` (\`agent: "omo/architect"\` or \`"omo/ultrabrain"\`, \`background: true\`) in the same wave as your research lanes, and integrate their answers before the approval brief. Every such prompt MUST start with TASK / DELIVERABLE / SCOPE / VERIFY / STOP WHEN and MUST declare itself advisory-only: read-only analysis, NO file edits, recommendations returned as text. Treat what comes back as claims to verify, not as decisions already made.

This section is an EXPLICIT EXCEPTION to the later rule "Never dispatch with \`category=\`" (in OpenCode 2: never dispatch to an \`omo/<category>\` lane): it authorizes exactly these two advisory lanes. Every other category dispatch stays forbidden. When neither agent is listed, skip these lanes silently.

`,
  },
  {
    file: "ulw-plan/references/full-workflow.md",
    replace: "### High-accuracy review (plan-reviewer-only in omo-senpi)\nIn omo-senpi the high-accuracy review is PLAN-REVIEWER-ONLY: one round is exactly ONE native `plan-reviewer` review",
    with: "### High-accuracy review (plan-reviewer-only)\nIn OpenCode 2 the high-accuracy review is PLAN-REVIEWER-ONLY: one round is exactly ONE `omo/plan-reviewer` subagent review",
  },
  {
    file: "ulw-plan/references/full-workflow.md",
    replace:
      "The harness forces the canonical contract and discards everything else, so literal substitution no longer applies to plan-reviewer dispatch. `task_send` to plan-reviewer is forbidden and refused by the harness; the only retry is fix-the-plan then spawn a NEW plan-reviewer.",
    with: "OpenCode 2 does not enforce this contract for you: send the plan path and nothing else, and never continue a plan-reviewer session by passing its `sessionID` again; the only retry is fix-the-plan then spawn a NEW plan-reviewer.",
  },
  {
    file: "ulw-plan/scripts/plan-templates.mjs",
    replace:
      '- Evidence: <attemptDir>/task-<N>-${slug}.<ext> (attemptDir = result.currentAttemptDir from await agentToolkit.status() in a JS eval cell after importing agentToolkit with await import(\\`\\${env("OMO_AGENT_TOOLKIT_SDK_ROOT")}/sdk.js\\`), .omo/evidence/ulw/<session>/<goalId>/a<attempt>; outside ulw-loop use .omo/evidence/)',
    with: "- Evidence: .omo/evidence/${slug}/task-<N>.<ext>",
  },
  {
    file: "ulw-execute/SKILL.md",
    replace:
      "This skill pairs with the harness's ulw-execute continuation hook, which re-injects the next turn while `.omo/boulder.json` says this `senpi:<session_id>` still has unchecked plan work.",
    with: "This skill pairs with the omo-opencode2 plugin's ulw-execute continuation hook, which re-injects the next turn while `.omo/boulder.json` says this `opencode2:<session_id>` still has unchecked plan work. Your session id is the `OPENCODE_SESSION_ID` environment variable of every `shell` command.",
  },
  {
    file: "ulw-execute/SKILL.md",
    replace: "Prefix session ids with `senpi:` so the continuation hook can identify its own session.",
    with: "Prefix session ids with `opencode2:` (`opencode2:$OPENCODE_SESSION_ID`) so the continuation hook can identify its own session.",
  },
  {
    file: "ulw-execute/SKILL.md",
    replace:
      '(category-capable harnesses pass it directly on the worker-spawn tool, e.g. `task(category="quick", ...)`; others map the parenthesized difficulty)',
    with: '(in OpenCode 2, spawn the worker with `subagent` and `agent: "omo/<category>"`, e.g. `omo/quick`)',
  },
  { file: "ulw-execute/SKILL.md", replace: "arm an explicit `monitor` on top of it", with: "start a background `shell` gate on top of it" },
  {
    file: "ulw-execute/SKILL.md",
    replace: "(`monitor` with a command that exits or emits on that condition)",
    with: "(a background `shell` command that exits on that condition)",
  },
  {
    file: "ulw-execute/SKILL.md",
    replace: 'A single `task_output({ mode: "tail" })` peek is allowed only when a midpoint decision genuinely depends on it.',
    with: "A single look at a running command's output is allowed only when a midpoint decision genuinely depends on it.",
  },
  { file: "ulw-execute/SKILL.md", replace: "The moment a monitor fires", with: "The moment a gate fires" },
  { file: "ulw-execute/SKILL.md", replace: "stop it with `kill_bash`", with: "stop its process" },
  { file: "ulw-research/SKILL.md", replace: "one eval cell batching the independent lookups", with: "one batch of parallel tool calls for the independent lookups" },
  {
    file: "ulw-research/SKILL.md",
    replace: '— peek a running lane with `task_output({ mode: "tail" })` when you need its transcript mid-run —',
    with: "— a lane shows no transcript mid-run here, so act on its completion notice —",
  },
  { file: "ulw-research/SKILL.md", replace: "Run the verification yourself in one eval cell,", with: "Run the verification yourself in one batch of tool calls," },
  {
    file: "ast-grep/SKILL.md",
    section: "## OmO native: the ast-grep MCP tools (fastest path, no CLI needed)",
    with: `## OpenCode 2: the ast-grep MCP tools (fastest path, no CLI needed)

The omo-opencode2 plugin registers a bundled \`ast_grep\` MCP server. Its three tools sit in the Code Mode catalog, so call them inside \`execute\`; their argument shapes are listed in that catalog.

- \`tools.ast_grep.search(...)\` — AST-shape search, the MCP equivalent of \`sg run -p\`. Prefer this over shelling out to \`sg\` for one-off lookups.
- \`tools.ast_grep.rewrite(...)\` — preview matches first, then apply the rewrite: the same two-pass discipline as \`sg run -r\`.
- \`tools.ast_grep.scan(...)\` — run project YAML rules, the MCP equivalent of \`sg scan\`.

Same pattern language as the CLI: \`$VAR\` matches one AST node, \`$$$VAR\` matches zero or more, and the pattern is code, not regex. Every path below also works with the \`sg\` CLI through \`shell\`; when \`sg\` is missing, install it with this skill's \`install.sh\`.

---

`,
  },
  {
    file: "browser/SKILL.md",
    section: "## Step 0 — inside OmO Desktop: everything above, plus the app's built-in browser",
    with: `## Step 0 — no app browser in OpenCode 2

OpenCode 2 never sets \`OMO_BROWSER_ENGINE\`, so \`connectBuiltinBrowser()\` (OmO Desktop's built-in browser) is unavailable here; use the engines above.

`,
  },
  { file: "browser/SKILL.md", replace: "in the terminal and inside OmO Desktop alike.", with: "in the terminal." },
  {
    file: "browser/references/commands.md",
    replace:
      "Inside OmO Desktop (`OMO_BROWSER_ENGINE` set), `connectBuiltinBrowser()` throws `BuiltinBrowserUnavailableError` (`code` `browser_builtin_unavailable`). Reasons `unavailable`, `timeout`, and `invalid_grant` mean the built-in browser is unavailable; `invalid_grant` includes a missing or unreadable token file. For `user_stopped` or any other app refusal, stop browser work and report it without opening another browser. Refresh uses the new grant's endpoint and token together; every other call behaves as in the terminal.",
    with: "`connectBuiltinBrowser()` needs OmO Desktop and always throws `BuiltinBrowserUnavailableError` in OpenCode 2; use the attached or owned engine instead.",
  },
  { file: "browser/references/install.md", section: "## Inside the OmO desktop app", with: "" },
]
