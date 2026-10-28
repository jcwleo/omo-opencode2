import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Skill, type Plugin } from "@opencode/plugin"

export const SKILLS_ROOT = fileURLToPath(new URL("../../skills/", import.meta.url))

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function readFrontmatter(path: string, markdown: string): { name?: string; description?: string; body: string } {
  const match = markdown.match(FRONTMATTER)
  if (match === null) return { body: markdown }
  const data: unknown = Bun.YAML.parse(match[1] ?? "")
  if (typeof data !== "object" || data === null) throw new Error(`${path}: frontmatter is not a mapping`)
  const name = "name" in data && typeof data.name === "string" ? data.name : undefined
  const description = "description" in data && typeof data.description === "string" ? data.description : undefined
  return { name, description, body: markdown.slice(match[0].length) }
}

export async function loadSkills(root: string = SKILLS_ROOT): Promise<Skill.Info[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const skills: Skill.Info[] = []
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name, "SKILL.md")
    const file = Bun.file(path)
    if (!(await file.exists())) continue
    const { name, description, body } = readFrontmatter(path, await file.text())
    skills.push({
      id: Skill.ID.make(entry.name),
      name: Skill.Name.make(name ?? entry.name),
      ...(description === undefined ? {} : { description }),
      path: Skill.Info.fields.path.make(path),
      content: body,
    })
  }
  return skills
}

export async function registerSkills(ctx: Plugin.Context, skills: readonly Skill.Info[]): Promise<void> {
  await ctx.skill.transform((editor) => {
    for (const skill of skills) editor.add(skill)
  })
}
