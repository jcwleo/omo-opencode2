## OpenCode 2 Tool Compatibility

Some examples in this skill use tool names from other agent harnesses. In OpenCode 2, use these tools instead:

| Example in this skill | OpenCode 2 |
| --- | --- |
| `task(subagent_type="explore", ...)`, `call_omo_agent(subagent_type="explore", ...)` | `subagent` with `agent: "omo/explore"` (likewise `omo/librarian`, `omo/plan-consultant`, `omo/plan-reviewer`, `omo/code-reviewer`, `omo/qa-executor`, `omo/gate-reviewer`) |
| `task(category="<name>", ...)` | `subagent` with `agent: "omo/<name>"` (`omo/quick`, `omo/unspecified-low`, `omo/unspecified-high`, `omo/deep-low`, `omo/deep-high`, `omo/ultrabrain`, `omo/visual-engineering`, `omo/writing`, `omo/artistry`, `omo/architect`) |
| `run_in_background=true` | `background: true`; you are notified when it finishes, so never poll |
| `background_output(...)`, `task_output(...)` | the result of a foreground `subagent` call, or the completion notice of a background one |
| `task_send(to=..., message=...)` | `subagent` again with the earlier `sessionID` |
| `team_create`, `team_*`, the team tasklist | no team tools: start each member as a background `subagent`, keep its `sessionID` for later rounds, and keep shared state in a file |
| `load_skills=[...]` | name the skills in the subagent prompt and tell it to load them with the `skill` tool |
| reading another skill's `SKILL.md` | the `skill` tool with that skill's id |
| `bash`, `tool.bash(...)` | `shell` |
| `monitor`, `bash(run_in_background=true)` | `shell` with `background: true` |
| `eval` cells, `parallel(...)` | several independent tool calls in one response; for a script, `shell` (`bun -e`, `python3 -c`) |
| `tool.grep(...)`, `find` | `grep`, `glob` |
| `ask_user_question` | `question` |
| `web_search`, `webfetch` | `websearch`, `webfetch` |
| `read`, `edit`, `write` | same names (`read` takes `path`; `edit` takes `oldString`/`newString`) |
| `todo`, `TodoWrite(...)` | `todowrite` when it is listed (OpenCode turns it on with the `experimental.todo` setting); otherwise keep the checklist in your reply or in a notes file |
| `lsp_*` tools | same names (`lsp_diagnostics`, `lsp_goto_definition`, `lsp_find_references`, `lsp_symbols`, `lsp_rename`), served by the plugin's `lsp` MCP server |
| `ast_grep` MCP tools (`search`, `rewrite`, `scan`) | `tools.ast_grep.search` / `rewrite` / `scan` inside `execute` (Code Mode); the `sg` CLI through `shell` also works |
| `memory` tool | same name when it is listed: the omo-opencode2 plugin serves it over the shared omo memory repo and commits each change |
| `workflow`, `show_html_page`, `create_goal` | not available in OpenCode 2: skip that step and say so |

If an example below conflicts with this section, this section wins.

# Phase 2 + 3 — Hypothesis Formation & Parallel Investigation

One hypothesis is a hunch. Three hypotheses is a decision. Investigation is how you turn the decision into runtime evidence.

---

## Phase 2 — Hypothesis Formation (Minimum Three)

### Why three, not one

A single hypothesis creates confirmation bias: you'll read runtime state looking for evidence that confirms it and unconsciously discount contradictions. Three hypotheses force you to design queries that *distinguish* between them, which is the only way runtime evidence becomes decisive.

### Generate across orthogonal axes

If your three hypotheses are all variations of "the handler has a bug", you don't actually have three hypotheses. Span the space:

| Axis | Example framing |
|---|---|
| **User-code logic** | "The handler early-returns because condition X is unexpectedly true" |
| **Library/SDK behavior** | "The third-party client swallows the error and returns a stub" |
| **Environment/config** | "The env var is read at module-load time before it gets populated, so it's empty" |
| **Async/timing** | "The promise rejects (or goroutine panics) after the response is already sent" |
| **Silent side-effect** | "An earlier turn mutated shared state that the current turn inherits" |
| **Observability gap** | "The error is raised but suppressed before logging; it only exists as an unawaited rejection / ignored signal" |
| **Binary-level** (when applicable) | "The function we think is running is actually jumped over by a patched thunk / a different version loaded" |
| **Build-vs-runtime** | "The code we're reading is not the code that's running — stale build, wrong symlink, cached wheel, or dist/ ahead of src/" |

### For each hypothesis, write in the journal

1. **Claim** — one sentence.
2. **Distinguishing evidence** — the exact value or state that confirms or refutes it, AND where to read it (file:line, log source, breakpoint location, memory address).
3. **If true, the fix is** — two words. Forces you to think through fix cost before committing to the hunt.

### Collapse rule

If two hypotheses have identical distinguishing evidence, they aren't actually different — collapse them and find a real alternative. If you can't come up with a third distinct hypothesis, you don't understand the system well enough yet. Go read a little more code before investigating.

---

## Phase 3 — Parallel Investigation

### State freshness invariant

**A debug session's state is a snapshot with a lifetime, not a fact you can carry forward indefinitely.**
- Before any action that mutates the debuggee, re-observe the session's current state.
- This includes continue, step, side-effecting evaluation, setting or removing breakpoints, and termination.
- Record the current thread state and stop reason; those are the concrete tells for whether the old plan still applies.
- An observation from an earlier turn may already be stale when the next action is issued.
- Turns can be minutes apart while the debuggee runs at full speed, so this failure mode is normal, not exceptional.
- If the thread state or stop reason has moved, re-observe the new state and do not replay the old plan.
- Treat every mutation as conditional on the state you just observed, not on a remembered stop.

### Failure-to-recovery taxonomy

| Failure signature | Most likely cause | Next move |
|---|---|---|
| Adapter or debugger process failed to start | Wrong binary or missing installation | Verify the tool exists, then re-launch; do not retry blindly. |
| Breakpoint accepted but never bound or verified | Source path mismatch, optimized-out code, or missing debug symbols | Check the binary was built with symbols and that the debugger-resolved path matches your file. |
| Attach refused | Permissions, ptrace scope, SIP, or wrong PID | Fix the environment or target identity; a retry will not change it. |
| No stop event within the expected window | Process is running, the breakpoint is unreachable, or the wait was too short | Pause and inspect threads rather than waiting longer. |
| Session terminated unexpectedly | The debuggee crashed or exited | Capture the exit and crash evidence before restarting. |

Branch depending on what's available.

### Path A: Team mode ENABLED

When the `team_*` tools are present, create a **debug-squad** team and split investigation across members working on different evidence sources. This is the right default whenever you have ≥3 hypotheses and any of them would take >10 minutes to investigate single-threaded.

**Team spec** — write to `~/.omo/teams/debug-squad/config.json`:

```json
{
  "name": "debug-squad",
  "members": [
    {
      "kind": "category",
      "category": "deep-low",
      "prompt": "You are the Runtime State Inspector. Your job: attach to the live process, hit breakpoints, read program state (variables, heap, goroutines, stack, registers depending on runtime), and report observed values verbatim. Never guess — if you don't see the value, say so. Report back via team_send_message with file:line / address references and captured values. Never edit source code. Never run git commands. If you need an instrumentation statement added (breakpoint(), debugger;, dbg!, etc.), ask the Lead first."
    },
    {
      "kind": "category",
      "category": "deep-low",
      "prompt": "You are the Log Archaeologist. Your job: grep server logs, stderr streams, SDK-internal debug output (DEBUG env, RUST_LOG, GODEBUG, PYTHONASYNCIODEBUG), and correlate timestamps. Produce a timeline of events with latencies. Flag anything that looks like a silent catch, a swallowed rejection, a panic recovered-and-ignored, a success response that contains failure signals (HTTP 200 with empty body, stopReason=error, exit 0 with error-in-stdout). Never edit source code."
    },
    {
      "kind": "category",
      "category": "deep-low",
      "prompt": "You are the Reproduction Engineer. Your job: build the smallest reliable repro — a curl command, a vitest/pytest/go test, a tmux script, a Playwright script for browser bugs, a pwntools script for binary targets. It must reproduce on first try and be copy-pasteable by the Lead. Document exact input, expected output, observed output. Save repro artifacts under /tmp/ and tell the Lead to journal them. If the bug is browser-based you MUST use Playwright CLI — do not simulate with curl."
    },
    {
      "kind": "category",
      "category": "deep-low",
      "prompt": "You are the Trace Correlator. Your job: take findings from the other members and cross-link them. Build a causal chain from symptom to suspected cause. Identify missing evidence. Propose the next single most-decisive runtime query. Never edit source code; only reason across already-captured evidence. If hypotheses diverge sharply after correlation, tell the Lead immediately — that is the signal for the Oracle Triple."
    }
  ]
}
```

**Assignment rule**: one hypothesis → one `team_task_create`. Give each hypothesis to the member whose evidence source is most likely to confirm or refute it. Broadcast the full hypothesis list once via `team_send_message(to="*")` so members know what the others are testing.

**Lead responsibilities**:
- Maintain the journal (members do not write to it).
- Approve any source-code edits (including `debugger;` / `breakpoint()` / `dbg!` statements).
- Synthesize member reports into updated hypothesis statuses.
- Decide when to disband: `team_shutdown_request` → `team_approve_shutdown` → `team_delete`.

**Team does NOT include Oracle** — Oracle is a hard-reject team member type. Oracle is used separately in Phase 4 (see `04-oracle-triple.md`).

### Path B: Team mode DISABLED

Fan out async explore/deep subagents instead. Same rule: one hypothesis per subagent.

```
task(subagent_type="explore", load_skills=[], run_in_background=true,
     prompt="[CONTEXT: bug summary + which hypothesis you own + what state to look at]
     Runtime state investigation for hypothesis 1: ...")
task(subagent_type="explore", load_skills=[], run_in_background=true,
     prompt="Log/timing investigation for hypothesis 2: ...")
task(category="deep-low", load_skills=[], run_in_background=true,
     prompt="Reproduction minimizer for hypothesis 3: ...")
```

End your response, wait for completion notifications, then synthesize.

---

## Evidence capture discipline (both paths)

For every piece of runtime state captured, record in the journal:

```markdown
### <ISO timestamp> — <what you looked at>
- Source: <file:line | log source | curl command | breakpoint address>
- Value: `<verbatim>`
- Interpretation: <one line — why this matters>
- Refutes/Confirms: H<n>
```

**Verbatim values only. No paraphrasing.**

- `messages.length=0` is evidence.
- "messages seemed empty" is not evidence — it's a memory of an observation, and memory of observations is where debug sessions go to die.

If you find yourself about to paraphrase, stop, go back, and copy the raw value.

---

## Round completion

A "round" is complete when every hypothesis has either confirming or refuting evidence — or when you have exhausted the evidence sources available without a decisive result. If the round ends inconclusively, that counts as a failed round for the counter in the journal. See `04-oracle-triple.md` for what to do at 2 consecutive failed rounds.
