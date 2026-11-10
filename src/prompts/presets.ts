import { buildPreset, resolvePresetName } from "./model-variants.generated.js"

export type ToolDescriptions = Readonly<Record<string, { readonly description: string }>>
type ToolNames = ReadonlySet<string>
export type PresetRewrite = { readonly pattern: RegExp; readonly with: string | ((tools: ToolNames) => string) }

const KEPT_PARTS = new Set(["core", "tuning"])

const TOOL_SNIPPETS: Readonly<Record<string, string>> = {
  read: "Read a file or directory",
  write: "Create or overwrite a file",
  edit: "Replace exact text in a file",
  patch: "Apply a patch that adds, updates, moves, or deletes files",
  glob: "Find files by glob pattern",
  grep: "Search file contents with ripgrep",
  shell: "Run a shell command; `background: true` for long runs, which notify you when they finish",
  skill: "Load a skill's instructions by id",
  subagent:
    "Delegate a task to a subagent session; `background: true` runs it in parallel and notifies you when it finishes, and a `sessionID` continues an earlier one",
  question: "Ask the user questions with options",
  webfetch: "Fetch a URL",
  websearch: "Search the web",
  todowrite: "Replace the todo list; each item has content and a status (pending, in_progress, completed, cancelled)",
  execute: "Run a script that calls the Code Mode tools listed in the Code Mode section",
}

// OpenCode's own base prompt fills `${OPENCODE_TOOL_GUIDANCE}` with these lines; replacing that prompt would drop them.
function toolGuidelines(tools: ToolNames): string[] {
  const lines: string[] = []
  if (tools.has("shell")) {
    lines.push(
      "Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
      "Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
    )
  }
  if (tools.has("write")) lines.push("Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.")
  if (tools.has("edit")) {
    lines.push(
      "Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
    )
  }
  return lines
}

const ASYNC_PARAGRAPH = [
  "**ASYNCHRONOUS IS THE DEFAULT FORM OF EVERY CALL THAT OFFERS ONE: A LONG `shell` COMMAND RUNS WITH `background: true` AND A CHILD TASK IS A `subagent` WITH `background: true` - NEVER A FOREGROUND CALL THAT SITS ON A `--watch` OR A SPAWNED PROCESS, NEVER A CHILD SPAWNED TO WATCH.**",
  "Each returns at once and delivers its result later as a notification; treat it like a pending async call and keep working on everything that does not need it.",
  "Block only on a call that finishes within the time a reply takes and decides your very next call, or on an approval-gated or destructive action you must watch directly.",
  "A child task never meets the first test; it runs in the background and its completion delivers its result.",
  "**THERE IS NO WAIT TOOL. END YOUR TURN WHEN THE NEXT STEP NEEDS A PENDING RESULT AND A NOTIFICATION WILL WAKE YOU; WITH NOTHING PENDING AND WORK STILL OPEN, THE TURN KEEPS GOING.**",
  "Repeated status reads, sleeps, and timed retries replay the whole context for nothing; a single peek serves a midpoint decision only.",
  "**EVERY CONDITION YOU WOULD OTHERWISE WAIT ON GETS A BACKGROUND `shell` COMMAND THAT EXITS WHEN THE CONDITION HOLDS** (`until <check>; do sleep 5; done`): a build, install, or test run finishing, a CI check or PR turning green, a deploy landing, a log line, a file appearing, another session or machine changing state. Start it the moment your work starts the run or the user names it; its completion wakes you.",
  "Steer or continue a running child by calling `subagent` again with its `sessionID` instead of launching a duplicate.",
].join(" ")

const todoTool = (tools: ToolNames): boolean => tools.has("todowrite")

// Senpi's file-operations tuning recognizes the GPT patch tool only as `apply_patch`; OpenCode calls it `patch`.
const OPENCODE_PATCH_TOOL = "patch"
const SENPI_PATCH_TOOL = "apply_patch"
const senpiToolName = (tool: string): string => (tool === OPENCODE_PATCH_TOOL ? SENPI_PATCH_TOOL : tool)

export const PRESET_REWRITES: readonly PresetRewrite[] = [
  {
    pattern: /through ask_user_question when it is available(?: \(waitForAnswer true when the next step depends on the answer\))?/g,
    with: "through the `question` tool when it is available",
  },
  {
    pattern: /call `todo` with atomic items before starting/g,
    with: (tools) => (todoTool(tools) ? "call `todowrite` with atomic items before starting" : "write a todo checklist of atomic items before starting"),
  },
  { pattern: /start with `todo`:/g, with: (tools) => (todoTool(tools) ? "start with `todowrite`:" : "start with a todo checklist:") },
  { pattern: /for 2\+ call `todo`:/g, with: (tools) => (todoTool(tools) ? "for 2+ call `todowrite`:" : "for 2+ keep a todo checklist:") },
  { pattern: /\bapply_patch\b/g, with: OPENCODE_PATCH_TOOL },
  { pattern: /via bash heredoc/g, with: "via `shell` heredoc" },
  { pattern: /invoked through bash/g, with: "invoked through `shell`" },
  { pattern: /through bash for the same purpose/g, with: "through `shell` for the same purpose" },
  { pattern: /one bash call per command/g, with: "one `shell` call per command" },
  {
    pattern: /- \*\*Delegate implementation via `bash`\.\*\* Spawn workers: [^\n]*?so you do not restate it\./g,
    with: "- **Delegate implementation via the `subagent` tool.** Spawn workers with `subagent` (`background: true` for parallel; each completion arrives as a notification).",
  },
  { pattern: /Spawn a separate `[^`\n]+ --print` review invocation/g, with: "Spawn a separate review `subagent`" },
  { pattern: /\*\*ASYNCHRONOUS IS THE DEFAULT FORM OF EVERY CALL THAT OFFERS ONE: BASH SESSIONS[^\n]*/g, with: ASYNC_PARAGRAPH },
]

export const LEFTOVER_PATTERN = /ask_user_question|waitForAnswer|tool\.monitor|bash sessions|eval cell that starts|`[^`\n]* --print|call `todo`/i

function snippetFor(name: string, description: string): string {
  return TOOL_SNIPPETS[name] ?? (description.split(/\n|(?<=[.!?])\s/)[0] ?? "").trim().slice(0, 160)
}

function openCodeNote(tools: ToolNames): string {
  const todo = todoTool(tools)
    ? "The todo tool here is `todowrite`: it replaces the whole list, each item with a status. Read `todo` in these instructions as `todowrite`, and \"todo labels\" as its item texts."
    : "There is no `todo` tool here: keep the todo list as a markdown checklist in your replies and read \"todo labels\" as its item texts."
  return `\n\n## OpenCode 2\n\n${todo}`
}

// GPT and Claude presets name the harness each family was trained in. Never "OpenCode": the Anthropic sign-in plugin
// deletes every paragraph that contains "You are OpenCode", which would take the preset's opening paragraph with it.
function appNameFor(preset: string): string {
  if (preset.startsWith("gpt-")) return "Codex"
  if (preset.startsWith("claude-")) return "Claude Code"
  return "omo"
}

export function renderPreset(name: string, tools: ToolDescriptions, hits?: Map<PresetRewrite, number>): string {
  const names = Object.keys(tools).sort()
  const available = new Set(names)
  const preset = buildPreset(name, {
    cwd: "",
    selectedTools: names.map(senpiToolName),
    toolSnippets: Object.fromEntries(names.map((tool) => [senpiToolName(tool), snippetFor(tool, tools[tool]?.description ?? "")])),
    promptGuidelines: toolGuidelines(available),
    contextFiles: [],
    skills: [],
    surface: "terminal",
    appName: appNameFor(name),
  })
  let text = preset.parts
    .filter((part) => KEPT_PARTS.has(part.name))
    .map((part) => part.text)
    .join("")
  for (const rewrite of PRESET_REWRITES) {
    const replacement = typeof rewrite.with === "string" ? rewrite.with : rewrite.with(available)
    hits?.set(rewrite, (hits.get(rewrite) ?? 0) + (text.match(rewrite.pattern)?.length ?? 0))
    text = text.replace(rewrite.pattern, () => replacement)
  }
  return text.trimEnd() + openCodeNote(available)
}

const rendered = new Map<string, string>()

export function presetPromptFor(providerID: string, modelID: string, tools: ToolDescriptions): string | undefined {
  const name = resolvePresetName({ providerID, modelID })
  if (name === undefined) return undefined
  const key = JSON.stringify([name, Object.keys(tools).sort().map((tool) => [tool, snippetFor(tool, tools[tool]?.description ?? "")])])
  const cached = rendered.get(key)
  if (cached !== undefined) return cached
  const prompt = renderPreset(name, tools)
  rendered.set(key, prompt)
  return prompt
}
