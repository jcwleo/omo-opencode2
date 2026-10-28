const SENPI_BANNER_HEADING = "## Senpi Harness Tool Compatibility"
const OPENCODE2_BANNER_HEADING = "## OpenCode 2 Tool Compatibility"

// Tool calls and parameters from the Senpi and OpenCode 1 harnesses that have no OpenCode 2 tool of the same name.
const FOREIGN_TOOL_PATTERN =
  /\b(?:call_omo_agent|background_output|background_cancel|task_output|task_send|task_cancel|ask_user_question|show_html_page|web_search|create_goal|update_goal|subagent_type|load_skills|run_in_background|eval|team_[a-z_]+)\b|\b(?:task|monitor|workflow|todo|memory|parallel|bash|lsp_[a-z_]+|ast_grep|tool\.[a-z]+)\s*\(/

const ULTRAWORK_VARIANT_MARKER = /^<!-- omo-ultrawork-astra:[a-z0-9-]+:(?:start|end) -->\r?\n/gm

const GENERIC_REWRITES: readonly (readonly [RegExp, string])[] = [
  [/\bomo-native-(code-reviewer|qa-executor|gate-reviewer)\b/g, "omo/$1"],
  [/\bsenpi:<session_id>/g, "opencode2:<session_id>"],
  [/\$omo:([a-z][a-z0-9-]*)/g, "$1"],
  [/\bomowright from js eval\b/g, "omowright in a Bun script run with `shell`"],
  [/\bfrom the\s+js[- ]eval kernel\b/g, "from a Bun script run with `shell`"],
  [/\bloaded from js eval\b/g, "loaded in a Bun script run with `shell`"],
  [/\bfrom the eval kernel\b/g, "from a Bun script run with `shell`"],
  [/\bload it from a js-eval cell\b/g, "load it in a Bun script run with `shell`"],
  [/\/\/ js-eval cell;/g, "// Bun script run with `shell`;"],
  [/js eval의 omowright/g, "`shell`로 실행하는 Bun 스크립트의 omowright"],
  [/js eval에서 omowright/g, "`shell`로 실행하는 Bun 스크립트에서 omowright"],
]

export const OPENCODE2_TOOL_COMPATIBILITY = `${OPENCODE2_BANNER_HEADING}

Some examples in this skill use tool names from other agent harnesses. In OpenCode 2, use these tools instead:

| Example in this skill | OpenCode 2 |
| --- | --- |
| \`task(subagent_type="explore", ...)\`, \`call_omo_agent(subagent_type="explore", ...)\` | \`subagent\` with \`agent: "omo/explore"\` (likewise \`omo/librarian\`, \`omo/plan-consultant\`, \`omo/plan-reviewer\`, \`omo/code-reviewer\`, \`omo/qa-executor\`, \`omo/gate-reviewer\`) |
| \`task(category="<name>", ...)\` | \`subagent\` with \`agent: "omo/<name>"\` (\`omo/quick\`, \`omo/unspecified-low\`, \`omo/unspecified-high\`, \`omo/deep-low\`, \`omo/deep-high\`, \`omo/ultrabrain\`, \`omo/visual-engineering\`, \`omo/writing\`, \`omo/artistry\`, \`omo/architect\`) |
| \`run_in_background=true\` | \`background: true\`; you are notified when it finishes, so never poll |
| \`background_output(...)\`, \`task_output(...)\` | the result of a foreground \`subagent\` call, or the completion notice of a background one |
| \`task_send(to=..., message=...)\` | \`subagent\` again with the earlier \`sessionID\` |
| \`team_create\`, \`team_*\`, the team tasklist | no team tools: start each member as a background \`subagent\`, keep its \`sessionID\` for later rounds, and keep shared state in a file |
| \`load_skills=[...]\` | name the skills in the subagent prompt and tell it to load them with the \`skill\` tool |
| reading another skill's \`SKILL.md\` | the \`skill\` tool with that skill's id |
| \`bash\`, \`tool.bash(...)\` | \`shell\` |
| \`monitor\`, \`bash(run_in_background=true)\` | \`shell\` with \`background: true\` |
| \`eval\` cells, \`parallel(...)\` | several independent tool calls in one response; for a script, \`shell\` (\`bun -e\`, \`python3 -c\`) |
| \`tool.grep(...)\`, \`find\` | \`grep\`, \`glob\` |
| \`ask_user_question\` | \`question\` |
| \`web_search\`, \`webfetch\` | \`websearch\`, \`webfetch\` |
| \`read\`, \`edit\`, \`write\` | same names (\`read\` takes \`path\`; \`edit\` takes \`oldString\`/\`newString\`) |
| \`todo\`, \`TodoWrite(...)\` | \`todowrite\` when it is listed (OpenCode turns it on with the \`experimental.todo\` setting); otherwise keep the checklist in your reply or in a notes file |
| \`lsp_*\` tools | same names (\`lsp_diagnostics\`, \`lsp_goto_definition\`, \`lsp_find_references\`, \`lsp_symbols\`, \`lsp_rename\`), served by the plugin's \`lsp\` MCP server |
| \`ast_grep\` MCP tools (\`search\`, \`rewrite\`, \`scan\`) | \`tools.ast_grep.search\` / \`rewrite\` / \`scan\` inside \`execute\` (Code Mode); the \`sg\` CLI through \`shell\` also works |
| \`memory\` tool | same name when it is listed: the omo-opencode2 plugin serves it over the shared omo memory repo and commits each change |
| \`workflow\`, \`show_html_page\`, \`create_goal\` | not available in OpenCode 2: skip that step and say so |

If an example below conflicts with this section, this section wins.

`

export function removeSectionUntilNextHeading(content: string, heading: string): string {
  const start = content.indexOf(heading)
  if (start === -1) return content
  const after = start + heading.length
  const next = /\n(?:---|#{1,6}\s)/g
  next.lastIndex = after
  const end = next.exec(content)
  return content.slice(0, start) + (end === null ? "" : content.slice(end.index + 1))
}

export function mentionsForeignTools(text: string): boolean {
  return FOREIGN_TOOL_PATTERN.test(text)
}

export function stripHarnessBanners(content: string): { readonly content: string; readonly hadSenpiBanner: boolean } {
  const hadSenpiBanner = content.includes(SENPI_BANNER_HEADING)
  const stripped = removeSectionUntilNextHeading(removeSectionUntilNextHeading(content, SENPI_BANNER_HEADING), OPENCODE2_BANNER_HEADING)
  return { content: stripped, hadSenpiBanner }
}

export function applyGenericRewrites(text: string): string {
  return GENERIC_REWRITES.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text)
}

export function stripUltraworkVariantMarkers(content: string): string {
  return content.replace(ULTRAWORK_VARIANT_MARKER, "")
}

export function insertCompatibilityBanner(content: string): string {
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/)
  if (frontmatter === null) return OPENCODE2_TOOL_COMPATIBILITY + content
  return frontmatter[0] + OPENCODE2_TOOL_COMPATIBILITY + content.slice(frontmatter[0].length)
}
