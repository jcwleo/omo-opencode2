import { mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { applyGenericRewrites } from "./adapt-skill.ts"

type FallbackRung = { readonly providers: readonly string[]; readonly model: string; readonly variant?: string }
type ToolRule = { readonly pattern: string; readonly allow: boolean }
type SenpiAgent = {
  readonly name: string
  readonly description?: string
  readonly prompt?: string
  readonly categories?: readonly string[]
  readonly tools?: readonly ToolRule[]
}
type SenpiCategory = { readonly name: string; readonly description: string; readonly callerGuidance?: string }
type Permission = { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }

const PROJECT_ROOT = resolve(import.meta.dir, "..")
const AGENTS_DIR = join(PROJECT_ROOT, "agents", "omo")
const ROUTING_FILE = join(PROJECT_ROOT, "src", "agents", "routing.generated.json")
const DEFAULT_FORK_PACKAGES = join(homedir(), "Projects/omo-fork/oh-my-openagent/packages")

const SENPI_TOOL_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  read: ["read"],
  find: ["glob"],
  ls: ["glob", "read"],
  grep: ["grep"],
  bash: ["shell"],
  write: ["edit"],
  x_search: ["websearch", "webfetch"],
  lsp_diagnostics: ["lsp_diagnostics"],
  lsp_goto_definition: ["lsp_goto_definition"],
  lsp_find_references: ["lsp_find_references"],
  lsp_symbols: ["lsp_symbols"],
}

const ENV_FILE_RULES: readonly Permission[] = [
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]

// The deep and unspecified prompts tell the lane to fan out explore and librarian, so those lanes may launch exactly those
// two read-only agents (OpenCode also needs `experimental.subagent_depth: 2`); every other category launches nothing.
const RESEARCH_SUBAGENTS = ["omo/explore", "omo/librarian"]
const RESEARCH_DELEGATING_CATEGORIES: ReadonlySet<string> = new Set(["deep-low", "deep-high", "unspecified-low", "unspecified-high"])

function categoryPermissions(category: string): Permission[] {
  return [
    { action: "subagent", resource: "*", effect: "deny" },
    ...(RESEARCH_DELEGATING_CATEGORIES.has(category) ? RESEARCH_SUBAGENTS.map((resource): Permission => ({ action: "subagent", resource, effect: "allow" })) : []),
    { action: "question", resource: "*", effect: "deny" },
  ]
}

// Senpi gives its curated read-only agents a broker that runs only `gh` read subcommands and curl GETs. OpenCode matches
// shell rules against each scanned command and the last match wins, so the `gh api` mutation forms follow the allow rule;
// HTTPS GETs move to `webfetch`.
const READ_ONLY_SHELL_ALLOW = [
  "gh search code *",
  "gh search commits *",
  "gh search issues *",
  "gh search prs *",
  "gh search repos *",
  "gh repo view *",
  "gh issue view *",
  "gh pr view *",
  "gh release view *",
  "gh release list *",
  "gh api *",
]
const READ_ONLY_SHELL_DENY = ["gh api graphql *", "gh api *-X *", "gh api *--method*", "gh api *-f *", "gh api *-F *", "gh api *--field*", "gh api *--raw-field*", "gh api *--input*"]

type AgentOverlay = { readonly agent: string; readonly field: "description" | "prompt"; readonly replace: string; readonly with: string }

// Tuned defaults that run ahead of each category's upstream chain, so a user without ~/.omo/omo.jsonc gets them; the
// upstream chain stays behind as the fallback for accounts that have neither model.
const OPENAI_PROVIDERS = ["openai", "chatgpt-subscription", "github-copilot", "opencode"]
const ANTHROPIC_PROVIDERS = ["anthropic", "anthropic-api", "github-copilot", "opencode"]
const openai = (model: string, variant: string): FallbackRung => ({ providers: OPENAI_PROVIDERS, model, variant })
const anthropic = (model: string, variant: string): FallbackRung => ({ providers: ANTHROPIC_PROVIDERS, model, variant })

const CATEGORY_CHAIN_PREFIXES: Readonly<Record<string, readonly FallbackRung[]>> = {
  "deep-low": [openai("gpt-6.1-sol", "medium"), anthropic("claude-opus-5-5", "medium")],
  "deep-high": [anthropic("claude-opus-5-5", "xhigh"), openai("gpt-6-astra", "high")],
  "unspecified-low": [openai("gpt-6.1-sol", "high"), anthropic("claude-opus-5-5", "high")],
  "unspecified-high": [anthropic("claude-opus-5-5", "xhigh"), openai("gpt-6-astra", "high")],
  ultrabrain: [openai("gpt-6-astra", "max"), anthropic("claude-fable-5-1", "max")],
  artistry: [anthropic("claude-fable-5-1", "max"), openai("gpt-6-astra", "max")],
  architect: [anthropic("claude-fable-5-1", "max"), openai("gpt-6-astra", "max")],
  "visual-engineering": [anthropic("claude-opus-5-5", "max"), openai("gpt-6.1-sol", "max")],
  writing: [anthropic("claude-opus-5-5", "low"), openai("gpt-6.1-sol", "medium")],
}

const REVIEW_REPORT_DEFAULT = "Write your report artifact to the path the caller gives you; when none is given, use"

const AGENT_OVERLAYS: readonly AgentOverlay[] = [
  {
    agent: "explore",
    field: "prompt",
    replace: "use the structured read-only bash broker only for supported gh or HTTPS retrieval requests; it is not a general shell",
    with: "use `shell` only for the read-only `gh` commands your permissions allow (`gh search`, `gh repo|issue|pr view`, `gh release view|list`, GET-only `gh api`) and `webfetch` for HTTPS pages; every other command is denied",
  },
  {
    agent: "librarian",
    field: "prompt",
    replace: [
      "- read, find, grep, and ls inspect files already present in the caller's workspace.",
      "- LSP diagnostics, definitions, references, and symbols inspect local code semantically.",
      "- bash is not a general shell. It accepts only a structured program plus argument vector and directly runs a bounded read-only gh or curl request.",
      "",
      "Valid remote-research shapes include:",
      "",
      '- bash with { program: "gh", args: ["repo", "view", "owner/repo", "--json", "url,homepageUrl"] }',
      '- bash with { program: "gh", args: ["search", "code", "symbolName", "--repo", "owner/repo", "--limit", "10"] }',
      '- bash with { program: "gh", args: ["api", "repos/owner/repo/commits/HEAD", "--jq", ".sha"] }',
      '- bash with { program: "curl", args: ["--silent", "--show-error", "--location", "https://docs.example.com/page"] }',
      "",
      "The broker rejects arbitrary commands, shell syntax, cloning, redirects, output files, uploads, request bodies, and non-read HTTP methods. Do not suggest npm, git, interpreters, pipes, command substitution, temporary checkouts, or filesystem writes. If the supported operations cannot retrieve evidence, state that limitation.",
    ].join("\n"),
    with: [
      "- `read`, `glob`, and `grep` inspect files already present in the caller's workspace.",
      "- `shell` runs only read-only `gh` commands (`gh search`, `gh repo|issue|pr view`, `gh release view|list`, GET-only `gh api`); every other command is denied. `webfetch` reads documentation pages and `websearch` searches the web.",
      "",
      "Valid remote-research shapes include:",
      "",
      "- `shell` with `gh repo view owner/repo --json url,homepageUrl`",
      "- `shell` with `gh search code symbolName --repo owner/repo --limit 10`",
      "- `shell` with `gh api repos/owner/repo/commits/HEAD --jq .sha`",
      "- `webfetch` with `https://docs.example.com/page`",
      "",
      "Keep every command read-only: no cloning, redirects to files, uploads, request bodies, non-read HTTP methods, package installs, or filesystem writes. If read-only operations cannot retrieve the evidence, state that limitation.",
    ].join("\n"),
  },
  {
    agent: "plan-consultant",
    field: "prompt",
    replace:
      'use the structured read-only `bash` broker with `{ program: "gh", args: ["search", "code", "<usage pattern>", "--language", "<lang>"] }` or `{ program: "curl", args: ["--silent", "--location", "https://official-docs.example/page"] }`.',
    with: 'use read-only `gh` commands through `shell`, such as `gh search code "<usage pattern>" --language <lang>`, or `webfetch` on an official documentation page.',
  },
  {
    agent: "plan-consultant",
    field: "prompt",
    replace:
      '2. External best practices via structured read-only `bash` using `program: "gh"` and a `search code` argument vector.\n3. Official documentation via structured read-only `bash` using `program: "curl"` and an HTTPS GET argument vector.',
    with: "2. External best practices via read-only `shell` `gh search code` queries.\n3. Official documentation via `webfetch` on HTTPS pages.",
  },
  {
    agent: "plan-consultant",
    field: "prompt",
    replace: "- **Structured read-only `bash` with `gh` / `curl`**:",
    with: "- **Read-only `gh` through `shell`, and `webfetch`**:",
  },
  {
    agent: "omo-native-code-reviewer",
    field: "description",
    replace: "OmO Native code-quality reviewer for ulw-loop final gates.",
    with: "Code-quality reviewer for final review gates (review-work, ulw-execute).",
  },
  {
    agent: "omo-native-code-reviewer",
    field: "prompt",
    replace:
      "Write your report artifact to `<attemptDir>/<goalId>-code-review.md`, where you read `currentAttemptDir` inside a JS eval cell: ``const { agentToolkit } = await import(`${env(\"OMO_AGENT_TOOLKIT_SDK_ROOT\")}/sdk.js`); const s = await agentToolkit.status(); print(s.result?.currentAttemptDir)`` (`.omo/evidence/ulw/<session>/<goalId>/a<attempt>`); when no ulw-loop plan exists, fall back to",
    with: REVIEW_REPORT_DEFAULT,
  },
  {
    agent: "omo-native-gate-reviewer",
    field: "description",
    replace: "OmO Native final gate reviewer for ulw-loop.",
    with: "Final gate reviewer for review-work and ulw-execute.",
  },
  {
    agent: "omo-native-gate-reviewer",
    field: "prompt",
    replace:
      "Write your report artifact to `<attemptDir>/<goalId>-gate-review.md`, where you read `currentAttemptDir` inside a JS eval cell: ``const { agentToolkit } = await import(`${env(\"OMO_AGENT_TOOLKIT_SDK_ROOT\")}/sdk.js`); const s = await agentToolkit.status(); print(s.result?.currentAttemptDir)`` (`.omo/evidence/ulw/<session>/<goalId>/a<attempt>`); when no ulw-loop plan exists, fall back to",
    with: REVIEW_REPORT_DEFAULT,
  },
  {
    agent: "omo-native-qa-executor",
    field: "description",
    replace: "OmO Native manual QA executor for ulw-loop final gates.",
    with: "Manual QA executor for final review gates (review-work, ulw-execute).",
  },
  {
    agent: "omo-native-qa-executor",
    field: "prompt",
    replace:
      "Write artifacts under the current attempt directory: read `currentAttemptDir` inside a JS eval cell: ``const { agentToolkit } = await import(`${env(\"OMO_AGENT_TOOLKIT_SDK_ROOT\")}/sdk.js`); const s = await agentToolkit.status(); print(s.result?.currentAttemptDir)`` (`.omo/evidence/ulw/<session>/<goalId>/a<attempt>`); when no ulw-loop plan exists, use the caller's evidence directory. Write the QA matrix itself to `<attemptDir>/<goalId>-manual-qa.md`.",
    with: "Write artifacts under the evidence directory the caller gives you (default `.omo/evidence/<goal>/`), and write the QA matrix itself to `<evidenceDir>/<goal>-manual-qa.md`.",
  },
  // Upstream's deep-* and unspecified-* gates point at each other ("no specialist category fits" next to a deep-low that
  // claims all backend and logic work), so the caller cannot tell them apart. These gates route by the shape of the work.
  {
    agent: "deep-low",
    field: "description",
    replace: "Of the two deep lanes this is the default: the child settles its decisions from what it reads. When unsure, choose deep-low;",
    with: "Route by the shape of the work, not its size. This is the default lane for one goal stated as an outcome (fix this, build that) whose decisions the child can settle from code, tests, and history, even when the change touches several files. Steps you can already write out go to unspecified-low (each step needs judgment) or quick (mechanical); one behavior change that must land consistently across many modules, tests, docs, and config goes to unspecified-high. Between the deep lanes, when unsure, choose deep-low;",
  },
  {
    agent: "deep-high",
    field: "description",
    replace: "Wide scope with easy decisions is deep-low or unspecified-high;",
    with: "Whatever the scope, easy decisions route elsewhere: one goal to deep-low, one change spread across many modules to unspecified-high;",
  },
  {
    agent: "unspecified-low",
    field: "description",
    replace: "Use only when no specialist category fits, effort is moderate, and scope stays within a few files/modules. Prefer any matching specialist category.",
    with: "Use when you can already write the steps, the work stays within a few files or modules, and each step needs judgment (a logic-preserving refactor, a contained cross-file API change). Mechanical steps are quick; a goal you can state only as an outcome is deep-low. Prefer any matching specialist category.",
  },
  {
    agent: "unspecified-high",
    field: "description",
    replace: "Use only when no specialist category fits and substantial effort spans systems/modules with broad impact. Use unspecified-low for contained moderate work.",
    with: "Use when one behavior change must land consistently across many modules and surfaces (callers, tests, docs, schemas, config) and its decisions are easy: breadth is the work. One goal in a contained area is deep-low, and a decision evidence cannot settle is deep-high whatever the scope; contained work whose steps you can write is unspecified-low. Prefer any matching specialist category.",
  },
]

function applyOverlays(owner: string, field: AgentOverlay["field"], text: string, applied: Set<AgentOverlay>): string {
  let next = text
  for (const overlay of AGENT_OVERLAYS.filter((candidate) => candidate.agent === owner && candidate.field === field)) {
    const matches = next.split(overlay.replace).length - 1
    if (matches !== 1) throw new Error(`agent overlay for ${owner}.${field}: expected 1 match of "${overlay.replace.slice(0, 80)}", found ${matches}`)
    next = next.replace(overlay.replace, () => overlay.with)
    applied.add(overlay)
  }
  return next
}

function applyAgentOverlays(agent: SenpiAgent, applied: Set<AgentOverlay>): { description: string; prompt: string } {
  return {
    description: applyGenericRewrites(applyOverlays(agent.name, "description", agent.description ?? "", applied)),
    prompt: applyGenericRewrites(applyOverlays(agent.name, "prompt", agent.prompt ?? "", applied)),
  }
}

const AGENT_TOOL_NOTE = `## OpenCode 2 tools

Where this prompt names tools from another agent harness, use these OpenCode 2 tools:
- \`find\`, \`ls\`: \`glob\`, or \`read\` on a directory
- \`bash\`: \`shell\`
- \`lsp_*\` tools: same names, served by the omo-opencode2 plugin's \`lsp\` MCP server
- \`x_search\`: \`websearch\` when it is allowed

You cannot spawn subagents or ask the user questions; report back to the caller instead.
`

function flagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined) throw new Error(`${flag} needs a directory`)
  return value
}

function agentId(senpiName: string): string {
  return senpiName.replace(/^omo-native-/, "")
}

function permissionsFor(tools: readonly ToolRule[], readOnlyShell: boolean): Permission[] {
  const actions = new Set(tools.filter((rule) => rule.allow).flatMap((rule) => SENPI_TOOL_ACTIONS[rule.pattern] ?? []))
  const brokeredShell = readOnlyShell && actions.delete("shell")
  if (brokeredShell) actions.add("webfetch")
  const rules: Permission[] = [{ action: "*", resource: "*", effect: "deny" }]
  for (const action of [...actions].sort()) rules.push({ action, resource: "*", effect: "allow" })
  if (brokeredShell) {
    for (const resource of READ_ONLY_SHELL_ALLOW) rules.push({ action: "shell", resource, effect: "allow" })
    for (const resource of READ_ONLY_SHELL_DENY) rules.push({ action: "shell", resource, effect: "deny" })
  }
  if (actions.has("read")) rules.push(...ENV_FILE_RULES)
  return rules
}

function frontmatter(description: string, permissions: readonly Permission[]): string {
  const lines = ["---", `description: ${JSON.stringify(description)}`, "mode: subagent", "permissions:"]
  for (const rule of permissions) {
    lines.push(`  - action: ${JSON.stringify(rule.action)}`, `    resource: ${JSON.stringify(rule.resource)}`, `    effect: ${rule.effect}`)
  }
  lines.push("---", "")
  return lines.join("\n")
}

async function main(): Promise<void> {
  const packages = resolve(flagValue("--fork") ?? process.env.OMO_FORK_PACKAGES ?? DEFAULT_FORK_PACKAGES)
  const builtinAgents: {
    BUILTIN_AGENT_DEFAULTS: readonly SenpiAgent[]
    AGENT_FALLBACK_CHAINS: Readonly<Record<string, readonly FallbackRung[]>>
    CURATED_READONLY_AGENT_NAMES: ReadonlySet<string>
  } =
    await import(join(packages, "senpi-task/src/agents/builtin/index.ts"))
  const categories: { BUILTIN_CATEGORY_DEFAULTS: readonly SenpiCategory[] } = await import(join(packages, "senpi-task/src/category/builtins.ts"))
  const modelCore: { CATEGORY_MODEL_REQUIREMENTS: Readonly<Record<string, { readonly fallbackChain: readonly FallbackRung[] }>> } =
    await import(join(packages, "model-core/src/category-model-requirements.ts"))
  const senpiChains: { CATEGORY_FALLBACK_CHAINS: Readonly<Record<string, readonly FallbackRung[]>> } = await import(
    join(packages, "senpi-task/src/category/fallback-chains.ts")
  )

  const categoryChain = (name: string): readonly FallbackRung[] => {
    const chain = modelCore.CATEGORY_MODEL_REQUIREMENTS[name]?.fallbackChain ?? senpiChains.CATEGORY_FALLBACK_CHAINS[name]
    if (chain === undefined) throw new Error(`neither model-core nor senpi-task has a fallback chain for category ${name}`)
    return chain
  }

  await rm(AGENTS_DIR, { recursive: true, force: true })
  await mkdir(AGENTS_DIR, { recursive: true })

  const routing: { agents: Record<string, { chain: readonly FallbackRung[] }>; categories: Record<string, { chain: readonly FallbackRung[] }> } = {
    agents: {},
    categories: {},
  }

  const appliedOverlays = new Set<AgentOverlay>()
  for (const agent of builtinAgents.BUILTIN_AGENT_DEFAULTS) {
    if (agent.prompt === undefined || agent.description === undefined) throw new Error(`builtin agent ${agent.name} has no prompt or description`)
    const { description, prompt } = applyAgentOverlays(agent, appliedOverlays)
    const id = agentId(agent.name)
    const chain = agent.categories === undefined ? builtinAgents.AGENT_FALLBACK_CHAINS[agent.name] : agent.categories.flatMap(categoryChain)
    if (chain === undefined) throw new Error(`builtin agent ${agent.name} has no fallback chain`)
    routing.agents[`omo/${id}`] = { chain }
    await Bun.write(join(AGENTS_DIR, `${id}.md`), `${frontmatter(description, permissionsFor(agent.tools ?? [], builtinAgents.CURATED_READONLY_AGENT_NAMES.has(agent.name)))}${prompt.trim()}\n\n${AGENT_TOOL_NOTE}`)
  }
  for (const category of categories.BUILTIN_CATEGORY_DEFAULTS) {
    const upstream = category.callerGuidance === undefined ? category.description : `${category.description}\n${category.callerGuidance}`
    const description = applyOverlays(category.name, "description", upstream, appliedOverlays)
    routing.categories[`omo/${category.name}`] = { chain: [...(CATEGORY_CHAIN_PREFIXES[category.name] ?? []), ...categoryChain(category.name)] }
    await Bun.write(join(AGENTS_DIR, `${category.name}.md`), frontmatter(description, categoryPermissions(category.name)))
  }
  const unknownPrefixes = Object.keys(CATEGORY_CHAIN_PREFIXES).filter((name) => routing.categories[`omo/${name}`] === undefined)
  if (unknownPrefixes.length > 0) throw new Error(`chain prefixes for missing categories: ${unknownPrefixes.join(", ")}`)
  const unapplied = AGENT_OVERLAYS.filter((overlay) => !appliedOverlays.has(overlay))
  if (unapplied.length > 0) throw new Error(`agent overlays for missing agents or categories: ${unapplied.map((overlay) => overlay.agent).join(", ")}`)

  await Bun.write(ROUTING_FILE, JSON.stringify(routing, null, 2) + "\n")
  const agentCount = Object.keys(routing.agents).length
  const categoryCount = Object.keys(routing.categories).length
  console.log(`wrote ${agentCount} agents and ${categoryCount} category agents into ${AGENTS_DIR}`)
}

await main()
