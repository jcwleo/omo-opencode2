import { Skill, type Plugin } from "@opencode/plugin"

export async function registerSkillCommands(ctx: Plugin.Context, skills: readonly Skill.Info[]): Promise<string[]> {
  const existing = new Set((await ctx.command.list()).data.map((command) => command.name))
  const commandSkills = skills.filter((skill) => !existing.has(skill.id))

  await ctx.command.transform((editor) => {
    for (const skill of commandSkills) {
      editor.add({
        name: skill.id,
        ...(skill.description === undefined ? {} : { description: skill.description }),
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: prompt.text.trim() === "" ? `Run the ${skill.id} skill.` : prompt.text,
            skills: [...(prompt.skills ?? []), { id: Skill.ID.make(skill.id) }],
            delivery,
          })
        },
      })
    }
  })
  return commandSkills.map((skill) => skill.id)
}
