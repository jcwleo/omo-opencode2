import { Plugin } from "@opencode/plugin"
import { loadAgentDefinitions } from "./agents/definitions.ts"
import { registerAgentRouting } from "./agents/index.ts"
import { registerSkillCommands } from "./commands/index.ts"
import { registerCommentChecker } from "./hooks/comment-checker.ts"
import { registerLspDiagnostics } from "./hooks/lsp-diagnostics.ts"
import { registerUlwExecuteContinuation } from "./hooks/ulw-execute-continuation.ts"
import { registerBuiltinMcps } from "./mcp/index.ts"
import { registerMemory } from "./memory/index.ts"
import { registerPromptHooks } from "./prompts/index.ts"
import { registerMainPrompt } from "./prompts/main-prompt.ts"
import { INTERNAL_SKILL_IDS } from "./skills/ids.ts"
import { loadSkills, registerSkills, SKILLS_ROOT } from "./skills/index.ts"

export default Plugin.define({
  id: "omo-opencode2",
  async setup(ctx) {
    const enabled = (option: string): boolean => ctx.options[option] !== false
    const skills = await loadSkills()
    const publicSkills = skills.filter((skill) => !INTERNAL_SKILL_IDS.has(String(skill.id)))
    if (publicSkills.length === 0) console.warn(`[omo-opencode2] no skills in ${SKILLS_ROOT}; run \`bun run sync:skills\``)
    await registerSkills(ctx, publicSkills)
    await registerPromptHooks(ctx, skills)
    const commands = await registerSkillCommands(ctx, publicSkills)
    const agents = await loadAgentDefinitions()
    const stops = [await registerAgentRouting(ctx, agents, { removeBuiltinSubagents: enabled("removeBuiltinSubagents"), sisyphus: enabled("sisyphus") })]
    if (enabled("mainPrompt")) await registerMainPrompt(ctx)
    const mcps = enabled("mcp") ? await registerBuiltinMcps(ctx) : []
    if (enabled("commentChecker")) await registerCommentChecker(ctx)
    if (enabled("lspDiagnostics")) await registerLspDiagnostics(ctx)
    if (enabled("ulwExecuteContinuation")) stops.push(await registerUlwExecuteContinuation(ctx))
    const memory = enabled("memory") ? await registerMemory(ctx, new Set(skills.map((skill) => String(skill.id)))) : undefined
    const hooks = ["mainPrompt", "commentChecker", "lspDiagnostics", "ulwExecuteContinuation"].filter(enabled)
    console.log(
      `[omo-opencode2] loaded in OpenCode ${ctx.app.version}: ${agents.length} agents, ${publicSkills.length} skills, ${commands.length} commands, mcp [${mcps.join(", ")}], hooks [${hooks.join(", ")}], memory ${memory === undefined ? "off" : `${memory.identity} (+${memory.skills} memory skills)`}`,
    )
    return () => {
      for (const stop of stops) stop()
    }
  },
})
