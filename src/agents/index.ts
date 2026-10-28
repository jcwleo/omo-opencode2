import { Model, Provider, type Plugin } from "@opencode/plugin"
import { categoryPromptAppend } from "../prompts/model-variants.generated.js"
import type { AgentDefinition } from "./definitions.ts"
import { loadOmoModelChains } from "./omo-config.ts"
import routing from "./routing.generated.json"

export type FallbackRung = { readonly providers: readonly string[]; readonly model: string; readonly variant?: string }
type AvailableModel = { readonly providerID: string; readonly id: string; readonly variants: readonly { readonly id: string }[] }
export type ModelChoice = { readonly providerID: string; readonly id: string; readonly variant?: string }

const AGENT_CHAINS: Readonly<Record<string, readonly FallbackRung[]>> = Object.fromEntries(
  [...Object.entries(routing.agents), ...Object.entries(routing.categories)].map(([id, entry]) => [id, entry.chain]),
)

const CATEGORY_AGENT_PREFIX = "omo/"
const CATEGORY_AGENT_IDS: ReadonlySet<string> = new Set(Object.keys(routing.categories))

export function parseModelChoice(value: string): ModelChoice {
  const match = value.match(/^([^/#]+)\/([^#]+)(?:#(.+))?$/)
  if (match === null || match[1] === undefined || match[2] === undefined) throw new Error(`model "${value}" is not provider/model[#variant]`)
  return { providerID: match[1], id: match[2], ...(match[3] === undefined ? {} : { variant: match[3] }) }
}

export function resolveChain(chain: readonly FallbackRung[], available: readonly AvailableModel[]): ModelChoice | undefined {
  for (const rung of chain) {
    for (const providerID of rung.providers) {
      const model = available.find((candidate) => candidate.providerID === providerID && candidate.id === rung.model)
      if (model === undefined) continue
      const variant = model.variants.some((candidate) => candidate.id === rung.variant) ? rung.variant : undefined
      return { providerID, id: model.id, ...(variant === undefined ? {} : { variant }) }
    }
  }
  return undefined
}

function readModelOverrides(options: Readonly<Record<string, unknown>>): Map<string, ModelChoice> {
  const raw = options.models
  if (raw === undefined) return new Map()
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("plugin option `models` must map agent ids to provider/model[#variant]")
  return new Map(
    Object.entries(raw).map(([agentId, value]) => {
      if (typeof value !== "string") throw new Error(`plugin option models.${agentId} must be a string`)
      return [agentId, parseModelChoice(value)]
    }),
  )
}

async function resolveAgentModels(
  ctx: Plugin.Context,
  overrides: ReadonlyMap<string, ModelChoice>,
  chains: Readonly<Record<string, readonly FallbackRung[]>>,
): Promise<Map<string, ModelChoice>> {
  const available = (await ctx.model.list()).data
  const resolved = new Map<string, ModelChoice>()
  for (const [agentId, chain] of Object.entries(chains)) {
    const choice = overrides.get(agentId) ?? resolveChain(chain, available)
    if (choice !== undefined) resolved.set(agentId, choice)
  }
  return resolved
}

// OpenCode's own subagents that the omo agents replace: `explore` by `omo/explore`, `general` by the category lanes.
const REPLACED_BUILTIN_SUBAGENTS = ["general", "explore"]

export async function registerAgentRouting(
  ctx: Plugin.Context,
  definitions: readonly AgentDefinition[],
  options: { readonly removeBuiltinSubagents: boolean },
): Promise<() => void> {
  const defined = definitions.map((definition) => definition.id).sort()
  const routed = Object.keys(AGENT_CHAINS).sort()
  if (defined.join("\n") !== routed.join("\n")) throw new Error(`agents/omo (${defined.join(", ")}) and routing.generated.json (${routed.join(", ")}) disagree; rerun \`bun run sync:agents\``)
  const overrides = readModelOverrides(ctx.options)
  const omo = loadOmoModelChains(ctx.location.directory)
  for (const message of omo.diagnostics) console.warn(`[omo-opencode2] omo config: ${message}`)
  // omo.json model lists come first and the builtin chain stays behind them, as in senpi-task.
  const chains = Object.fromEntries(Object.entries(AGENT_CHAINS).map(([agentId, chain]) => [agentId, [...(omo.chains.get(agentId) ?? []), ...chain]]))
  let resolved = await resolveAgentModels(ctx, overrides, chains)

  // Plugin transforms run before the config layer, so a user's `agents.<id>` entry still overrides these fields and its
  // permission rules land after the ones registered here.
  await ctx.agent.transform((editor) => {
    for (const definition of definitions) {
      editor.update(definition.id, (agent) => {
        agent.mode = "subagent"
        agent.description = definition.description
        if (definition.system !== undefined) agent.system = definition.system
        agent.permissions = [...agent.permissions, ...definition.permissions]
      })
    }
    if (options.removeBuiltinSubagents) for (const id of REPLACED_BUILTIN_SUBAGENTS) editor.remove(id)
    for (const [agentId, choice] of resolved) {
      editor.update(agentId, (agent) => {
        if (agent.model !== undefined) return
        agent.model = {
          providerID: Provider.ID.make(choice.providerID),
          id: Model.ID.make(choice.id),
          ...(choice.variant === undefined ? {} : { variant: Model.VariantID.make(choice.variant) }),
        }
      })
    }
  })

  await ctx.session.hook("context", (event) => {
    if (!CATEGORY_AGENT_IDS.has(event.agent)) return
    const append = categoryPromptAppend(event.agent.slice(CATEGORY_AGENT_PREFIX.length), event.model.id)
    if (append !== undefined) event.system.push({ type: "text", text: append })
  })

  const controller = new AbortController()
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type !== "model.updated") continue
      resolved = await resolveAgentModels(ctx, overrides, chains)
      await ctx.agent.reload()
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) console.error("[omo-opencode2] model.updated subscription stopped", error)
  })
  return () => controller.abort()
}
