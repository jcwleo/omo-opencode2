import type { Plugin } from "@opencode/plugin"
import { presetPromptFor } from "./presets.ts"

export async function registerMainPrompt(ctx: Plugin.Context): Promise<void> {
  await ctx.session.hook("context", async (event) => {
    const base = event.system[0]
    if (base === undefined || base.type !== "text") return
    const prompt = presetPromptFor(event.model.providerID, event.model.id, event.tools)
    if (prompt === undefined) return
    const agent = (await ctx.agent.get({ agentID: event.agent })).data
    if ((agent.system ?? "").trim() !== "") return
    event.system[0] = { ...base, text: prompt }
  })
}
