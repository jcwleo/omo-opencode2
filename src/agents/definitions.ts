import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const AGENTS_ROOT = fileURLToPath(new URL("../../agents/omo/", import.meta.url))

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const EFFECTS: ReadonlySet<string> = new Set(["allow", "ask", "deny"])

export type AgentPermission = { readonly action: string; readonly resource: string; readonly effect: "allow" | "ask" | "deny" }
export type AgentDefinition = { readonly id: string; readonly description: string; readonly permissions: readonly AgentPermission[]; readonly system?: string }

function parsePermission(path: string, value: unknown): AgentPermission {
  if (typeof value !== "object" || value === null) throw new Error(`${path}: permission entry is not a mapping`)
  const { action, resource, effect } = value as Record<string, unknown>
  if (typeof action !== "string" || typeof resource !== "string" || typeof effect !== "string" || !EFFECTS.has(effect)) {
    throw new Error(`${path}: permission entry needs string action and resource and an allow|ask|deny effect`)
  }
  return { action, resource, effect: effect as AgentPermission["effect"] }
}

export function parseAgentDefinition(id: string, path: string, markdown: string): AgentDefinition {
  const match = markdown.match(FRONTMATTER)
  if (match === null) throw new Error(`${path}: missing frontmatter`)
  const data: unknown = Bun.YAML.parse(match[1] ?? "")
  if (typeof data !== "object" || data === null) throw new Error(`${path}: frontmatter is not a mapping`)
  const { description, mode, permissions } = data as Record<string, unknown>
  if (typeof description !== "string") throw new Error(`${path}: description must be a string`)
  if (mode !== "subagent") throw new Error(`${path}: mode must be subagent`)
  if (!Array.isArray(permissions)) throw new Error(`${path}: permissions must be a list`)
  const system = markdown.slice(match[0].length).trim()
  return { id, description, permissions: permissions.map((entry) => parsePermission(path, entry)), ...(system === "" ? {} : { system }) }
}

export async function loadAgentDefinitions(root: string = AGENTS_ROOT): Promise<AgentDefinition[]> {
  const files = (await readdir(root)).filter((file) => file.endsWith(".md")).sort()
  return Promise.all(
    files.map(async (file) => {
      const path = join(root, file)
      return parseAgentDefinition(`omo/${file.slice(0, -".md".length)}`, path, await Bun.file(path).text())
    }),
  )
}
