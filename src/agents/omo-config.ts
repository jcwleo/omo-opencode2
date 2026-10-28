import { loadOmoConfig, type OmoModelEntry, type OmoModelOwner } from "../omo/core.generated.js"
import type { FallbackRung } from "./index.ts"

// Senpi names its subscription accounts with its own provider ids; OpenCode 2 reaches the same accounts
// through these providers (ChatGPT sign-in under `openai`, Claude Pro/Max under `anthropic`).
const SENPI_PROVIDER_IDS: Readonly<Record<string, string>> = {
  "chatgpt-subscription": "openai",
  "anthropic-subscription": "anthropic",
  "anthropic-api": "anthropic",
}

const CATEGORY_AGENT_PREFIX = "omo/"
const NATIVE_AGENT_PREFIX = /^omo-native-/

function toRung(entry: string | OmoModelEntry, ownerReasoning: string | undefined): FallbackRung | undefined {
  const spec = typeof entry === "string" ? entry : entry.model
  const match = spec.match(/^([^/#]+)\/([^#]+)(?:#(.+))?$/)
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined
  const reasoning = (typeof entry === "string" ? match[3] : entry.reasoning ?? match[3]) ?? ownerReasoning
  const variant = reasoning === undefined || reasoning === "auto" ? undefined : reasoning === "off" ? "none" : reasoning
  return { providers: [SENPI_PROVIDER_IDS[match[1]] ?? match[1]], model: match[2], ...(variant === undefined ? {} : { variant }) }
}

function ownerRungs(owner: OmoModelOwner): FallbackRung[] {
  const fallback = owner.fallback_models === undefined ? [] : typeof owner.fallback_models === "string" ? [owner.fallback_models] : owner.fallback_models
  const entries = owner.models !== undefined && owner.models.length > 0 ? owner.models : [...(owner.model === undefined ? [] : [owner.model]), ...fallback]
  return entries.map((entry) => toRung(entry, owner.reasoning)).filter((rung): rung is FallbackRung => rung !== undefined)
}

export function loadOmoModelChains(directory: string): { readonly chains: ReadonlyMap<string, readonly FallbackRung[]>; readonly diagnostics: readonly string[] } {
  const { config, diagnostics } = loadOmoConfig({ cwd: directory, harness: "opencode" })
  const chains = new Map<string, readonly FallbackRung[]>()
  for (const [name, owner] of Object.entries(config.categories ?? {})) {
    const rungs = ownerRungs(owner)
    if (rungs.length > 0) chains.set(`${CATEGORY_AGENT_PREFIX}${name}`, rungs)
  }
  for (const [name, owner] of Object.entries(config.agents ?? {})) {
    const rungs = ownerRungs(owner)
    if (rungs.length > 0) chains.set(`${CATEGORY_AGENT_PREFIX}${name.replace(NATIVE_AGENT_PREFIX, "")}`, rungs)
  }
  return { chains, diagnostics: diagnostics.map((diagnostic) => diagnostic.message) }
}
