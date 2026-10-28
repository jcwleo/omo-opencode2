---
name: git-master
description: "MUST USE for ANY git operations: atomic commits, rebase/squash/fixup, and history search (blame, bisect, log -S, reflog). Load it before running git yourself, or pass load_skills=['git-master'] to the task that commits. Triggers: 'commit', 'rebase', 'squash', 'who wrote', 'when was X added', 'find the commit that'."
---

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

# Git Master

Use this skill when the user asks you to operate on Git history or answer a Git-history question. Be exact, conservative, and evidence-led. Read the repository state before you infer anything.

## Mode Gate

Classify the request first:

- `COMMIT`: stage and commit local changes.
- `REBASE`: rebase, squash, fixup, autosquash, reorder, split, or otherwise rewrite branch history.
- `HISTORY`: answer when, where, who, why, or which commit changed something.
- `STATUS`: inspect branch, diff, or working-tree state without changing it.

Do not commit, rebase, push, force-push, reset, stash-pop, or delete anything unless the user explicitly asked for that operation. If the request is only investigative, report findings and stop.

## Ground Truth

Gather independent facts in parallel when the tools allow it:

```bash
git status --short
git diff --stat
git diff --staged --stat
git branch --show-current
git log -30 --oneline
git log -30 --pretty=format:%s
git rev-parse --abbrev-ref @{upstream}
git merge-base HEAD origin/main
git merge-base HEAD origin/master
```

Missing upstream or missing `main`/`master` is normal. Fall back to the best available branch or report the missing fact. Never treat a failed lookup as proof.

## PR Body Evidence Attachments

When a PR body needs screenshots or terminal PNGs, use the repo reference at `docs/reference/github-attachment-upload.md`. The allowed hosting path is GitHub user attachments from the authenticated web attachment flow; never commit temporary images, never use GitHub Releases for PR evidence, and never use external image hosts. Do not log browser cookies, CSRF tokens, S3 form fields, or upload headers.

## Commit Mode

Commit only the user's requested changes. Preserve unrelated dirty work.

1. Detect message style from recent history. Use the dominant local pattern, language, and casing. Do not default to Conventional Commits unless the repo uses them.
2. Inspect the full diff, not only filenames. Separate unrelated user edits from the requested commit.
3. Build atomic groups by behavior, module, and revertability. Keep implementation and its direct tests together.
4. Prefer multiple commits for unrelated concerns. A single commit is acceptable only when the changed files form one indivisible behavior or the user explicitly asks for one commit.
5. Stage by path or hunk so each commit contains only its atomic group.
6. Before each commit, verify `git diff --staged --stat` and enough staged diff to prove the group is right.
7. Commit with the detected style. After each commit, verify `git log -1 --oneline`.

Grouping rules:

- Split different features, modules, generated artifacts, config, docs, and test-only changes unless they are inseparable.
- Keep generated files with the source change that produced them when omitting them would leave the repo inconsistent.
- Never hide failing or unrelated changes inside a broad commit.

Final report: list commit hashes, messages, and any remaining uncommitted files.

## Rebase Mode

History rewriting is a shared-impact operation.

- Never rebase or rewrite `main`, `master`, `dev`, release branches, or a protected branch unless the user explicitly named that exact operation.
- If commits may already be pushed, ask before force-pushing. Use `--force-with-lease`, never plain `--force`.
- If the worktree is dirty, preserve it intentionally before rebasing. Do not stash-pop over conflicts without checking what changed.
- For fixups, prefer `git commit --fixup=<hash>` followed by `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <base>`.
- For conflicts, read the conflicting files and resolve by intent. Do not choose ours/theirs blindly.
- If a rebase goes wrong, use `git rebase --abort` first. Use reflog only after explaining the recovery path.

After rewriting, run the relevant tests or at least the project's cheapest smoke check, then show the new branch log from base to HEAD.

## History Mode

Choose the Git tool by the question:

- `git log -S "text"`: when the count of an exact string changed.
- `git log -G "regex"`: when diffs touched lines matching a pattern.
- `git blame -L start,end -- file`: who last changed specific lines.
- `git log --follow -- file`: history across renames for one file.
- `git show <hash>`: inspect the commit that appears relevant.
- `git bisect`: find the first bad commit when there is a deterministic pass/fail command and known good/bad bounds.
- `git reflog`: recover or explain recent local history movement.

Always cite the exact command evidence in the answer: commit hash, subject, file path, and line or diff context when relevant. If the evidence is ambiguous, say what remains unproven.

## Safety Checks

Before any write to Git history:

- Current branch is known.
- Dirty work is accounted for.
- Upstream/pushed status is known or explicitly unknown.
- The operation matches the user's request.
- Recovery path is known (`rebase --abort`, reflog hash, or untouched worktree).

Before finishing:

- Run the most relevant verification available for the changed behavior or history operation.
- Report commands that passed and any command you could not run.
- Leave the worktree state explicit.
