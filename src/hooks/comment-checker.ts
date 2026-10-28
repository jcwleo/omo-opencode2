import type { Plugin } from "@opencode/plugin"
import {
  COMMENT_CHECKER_FEEDBACK_HEADER,
  defaultRunCommentChecker,
  downloadSenpiCommentCheckerBinary,
  extractApplyPatchEdits,
  resolveSenpiCommentCheckerBinary,
  type CommentCheckerHookInput,
} from "../omo/core.generated.js"
import { appendToolText, isRecord, omoLogger } from "../omo/shared.ts"
import { absolutePath, MUTATION_TOOLS } from "./mutated-files.ts"

type CheckTarget = { readonly filePath: string; readonly toolName: string; readonly toolInput: CommentCheckerHookInput["tool_input"] }

// The checker finds nothing in an `apply_patch` call that carries only a path, so each patched file is
// checked as the write (added file) or edit (before -> after) it amounts to.
function checkTargets(tool: string, input: Record<string, unknown>, metadata: unknown, directory: string): CheckTarget[] {
  if (tool === "patch") {
    return extractApplyPatchEdits(metadata, input).map((edit) => {
      const filePath = absolutePath(directory, edit.filePath)
      const after = edit.after ?? ""
      return edit.before === undefined || edit.before === ""
        ? { filePath, toolName: "write", toolInput: { file_path: filePath, content: after } }
        : { filePath, toolName: "edit", toolInput: { file_path: filePath, old_string: edit.before, new_string: after } }
    })
  }
  if (typeof input.path !== "string" || input.path.length === 0) return []
  const filePath = absolutePath(directory, input.path)
  if (tool === "write" && typeof input.content === "string") return [{ filePath, toolName: "write", toolInput: { file_path: filePath, content: input.content } }]
  if (tool === "edit" && typeof input.oldString === "string" && typeof input.newString === "string") {
    return [{ filePath, toolName: "edit", toolInput: { file_path: filePath, old_string: input.oldString, new_string: input.newString } }]
  }
  return [{ filePath, toolName: tool, toolInput: { file_path: filePath } }]
}

export async function registerCommentChecker(ctx: Plugin.Context): Promise<void> {
  const directory = ctx.location.directory
  const reportedThisTurn = new Map<string, Set<string>>()
  let binary: Promise<string | null> | undefined
  let inert = false

  await ctx.session.hook("context", (event) => {
    reportedThisTurn.delete(event.sessionID)
  })

  await ctx.tool.hook("execute.after", async (event) => {
    if (inert || event.status !== "completed" || !MUTATION_TOOLS.has(event.tool)) return
    const input = isRecord(event.input) ? event.input : {}
    const reported = reportedThisTurn.get(event.sessionID) ?? new Set<string>()
    const targets = checkTargets(event.tool, input, event.result.metadata, directory).filter((target) => !reported.has(target.filePath))
    if (targets.length === 0) return

    binary ??= Promise.resolve(resolveSenpiCommentCheckerBinary()).then((found) => found ?? downloadSenpiCommentCheckerBinary({ logger: omoLogger }))
    const binaryPath = await binary
    if (binaryPath === null) {
      inert = true
      omoLogger.warn("comment-checker binary unavailable; comment checks are off for this server")
      return
    }

    const feedback: string[] = []
    for (const { filePath, toolName, toolInput } of targets) {
      const hookInput: CommentCheckerHookInput = {
        session_id: event.sessionID,
        tool_name: toolName,
        transcript_path: "",
        cwd: directory,
        hook_event_name: "PostToolUse",
        tool_input: toolInput,
        tool_response: { content: event.result.content },
      }
      const result = await defaultRunCommentChecker({ binaryPath, hookInput })
      if (result.failure !== undefined) {
        // A checker that cannot start fails the same way on every edit, so stop re-running it.
        inert = true
        omoLogger.warn("comment-checker could not run; comment checks are off for this server", { binaryPath, exitCode: result.failure.exitCode })
        break
      }
      const message = result.message.replace(/\r\n?/g, "\n").trim()
      if (!result.hasComments || message.length === 0) continue
      reported.add(filePath)
      feedback.push(`${COMMENT_CHECKER_FEEDBACK_HEADER} ${filePath}:\n${message}`)
    }
    reportedThisTurn.set(event.sessionID, reported)
    if (feedback.length > 0) event.result = { ...event.result, content: appendToolText(event.result.content, feedback.join("\n\n")) }
  })
}
