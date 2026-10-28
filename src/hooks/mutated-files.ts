import { isAbsolute, resolve } from "node:path"
import { extractApplyPatchEdits } from "../omo/core.generated.js"
import { isRecord } from "../omo/shared.ts"

export const MUTATION_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "patch"])

export function absolutePath(directory: string, path: string): string {
  return isAbsolute(path) ? path : resolve(directory, path)
}

export function mutatedFilePaths(tool: string, input: unknown, metadata: unknown, directory: string): string[] {
  const args = isRecord(input) ? input : {}
  if (tool === "patch") {
    const paths = extractApplyPatchEdits(metadata, args).map((edit) => absolutePath(directory, edit.filePath))
    return paths.filter((path, index) => paths.indexOf(path) === index)
  }
  return typeof args.path === "string" && args.path.length > 0 ? [absolutePath(directory, args.path)] : []
}
