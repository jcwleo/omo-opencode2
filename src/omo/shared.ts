import { fileURLToPath } from "node:url"

export const RUNTIME_ROOT = fileURLToPath(new URL("../../runtime/", import.meta.url))

type ToolContent = string | ReadonlyArray<{ readonly type: "text"; readonly text: string } | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }>

export function appendToolText(content: ToolContent | undefined, text: string): ToolContent {
  if (content === undefined) return text
  if (typeof content === "string") return content.length === 0 ? text : `${content}\n\n${text}`
  return [...content, { type: "text", text }]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const omoLogger = {
  info: (message: string, meta?: unknown) => console.log(`[omo-opencode2] ${message}`, meta ?? ""),
  warn: (message: string, meta?: unknown) => console.warn(`[omo-opencode2] ${message}`, meta ?? ""),
}
