export interface OmoModelEntry {
  readonly model: string
  readonly reasoning?: string
}

export interface OmoModelOwner {
  readonly model?: string
  readonly models?: readonly (string | OmoModelEntry)[]
  readonly fallback_models?: string | readonly (string | OmoModelEntry)[]
  readonly reasoning?: string
}

export interface OmoConfigDiagnostic {
  readonly kind: string
  readonly message: string
  readonly path?: string
}

export declare function loadOmoConfig(options?: { cwd?: string; harness?: string }): {
  readonly config: {
    readonly categories?: Readonly<Record<string, OmoModelOwner>>
    readonly agents?: Readonly<Record<string, OmoModelOwner>>
    readonly memory?: OmoMemorySettings
  }
  readonly diagnostics: readonly OmoConfigDiagnostic[]
}

export interface OmoLogger {
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
}

export interface CommentCheckerHookInput {
  readonly session_id: string
  readonly tool_name: string
  readonly transcript_path: string
  readonly cwd: string
  readonly hook_event_name: string
  readonly tool_input: {
    readonly file_path?: string
    readonly content?: string
    readonly old_string?: string
    readonly new_string?: string
  }
  readonly tool_response?: unknown
}

export declare const COMMENT_CHECKER_FEEDBACK_HEADER: string
export declare function resolveSenpiCommentCheckerBinary(): string | null
export declare function downloadSenpiCommentCheckerBinary(options: { logger: OmoLogger }): Promise<string | null>
export declare function defaultRunCommentChecker(input: { binaryPath: string; hookInput: CommentCheckerHookInput }): Promise<{
  readonly hasComments: boolean
  readonly message: string
  readonly failure?: { readonly exitCode: number | null; readonly stderr: string }
}>
export declare function extractApplyPatchEdits(
  details: unknown,
  args?: Record<string, unknown>,
): readonly { readonly filePath: string; readonly before?: string; readonly after?: string }[]

export type PostEditDiagnosticsOutcome =
  | string
  | { readonly kind: "not_configured"; readonly extension: string }
  | { readonly kind: "not_installed"; readonly serverId: string; readonly installDecisionTool: boolean; readonly text: string }
export type PostEditFileLocation = "project" | "outside_project" | "agent_config" | "temp"
export interface PostEditNotConfiguredCache {
  readonly notConfiguredExtensions: Set<string>
  readonly notInstalledServers: Set<string>
}
export declare function createPostEditNotConfiguredCache(): PostEditNotConfiguredCache
export declare function resetPostEditNotConfiguredCache(cache: PostEditNotConfiguredCache): void
export declare function classifyPostEditFileLocation(filePath: string, options: { cwd: string; agentDirs: readonly string[] }): PostEditFileLocation
export declare function collectPostEditDiagnostics(input: {
  filePaths: readonly string[]
  runDiagnostics: (filePath: string) => Promise<PostEditDiagnosticsOutcome>
  cache?: PostEditNotConfiguredCache
  maxConcurrency?: number
  locateFile?: (filePath: string) => PostEditFileLocation
}): Promise<{ readonly blocks: readonly { readonly filePath: string; readonly diagnostics: string; readonly blocking: boolean }[] }>
export declare function postEditOutcomeFromDaemonResult(result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[]
  readonly details?: unknown
}): PostEditDiagnosticsOutcome

export interface BoulderWork {
  readonly work_id: string
  readonly status?: string
  readonly plan_name: string
  readonly active_plan: string
  readonly started_at: string
  readonly updated_at?: string
  readonly worktree_path?: string | null
}
export declare function getWorkForSession(directory: string, sessionId: string): BoulderWork | null
export declare function resolveBoulderPlanPathForWork(directory: string, work: BoulderWork): string
export interface OmoMemorySettings {
  readonly enabled: boolean
  readonly agent: string
  readonly auto_identity: "path" | "git"
  readonly nudge: { readonly enabled: boolean; readonly every_user_turns: number }
}
export declare const OmoMemorySettingsSchema: { parse(value: unknown): OmoMemorySettings }

export interface MemoryIdentity {
  readonly id: string
  readonly paths: { readonly root: string; readonly repo: string; readonly locks: string }
}
export declare function resolveAutoIdentity(cwd: string, env?: Record<string, string | undefined>, mode?: "path" | "git"): MemoryIdentity
export declare function resolveMemoryIdentity(agent: string | null | undefined, cwd: string, env?: Record<string, string | undefined>): MemoryIdentity
export declare function isAutoAgentValue(value: string | null | undefined): boolean

export interface MemoryCommit {
  readonly sha: string
  readonly trailers: Readonly<Record<string, string>>
}
export declare class GitMemoryRepo {
  constructor(options: { dir: string; agentId: string })
  head(): Promise<string | null>
  init(options?: { seedFiles?: readonly unknown[]; installHooks?: (dir: string) => void }): Promise<string>
  log(options?: { grep?: readonly string[]; limit?: number; timeoutMs?: number; range?: string; since?: Date }): Promise<readonly MemoryCommit[]>
}
export declare function compileMemoryBlockAtRevision(repo: GitMemoryRepo, revision: string | null, options: { agentId: string }): Promise<string>
export declare function markMemoryBlock(identity: string, block: string): string

export type ClaimReceipt = { readonly source: "user" | "agent" | "inferred" } & Readonly<Record<string, unknown>>
export declare function resolveClaimReceipt(
  claim: { readonly source: unknown; readonly userQuote: unknown },
  exchanges: readonly { readonly proposal: string; readonly reply: string }[],
): ClaimReceipt
export declare const USER_QUOTE_RULE: string
export declare const MEMORY_TOOL_DESCRIPTION: string

export type MemoryToolLock = <T>(domain: string, operation: () => Promise<T>) => Promise<T>
export interface MemoryToolParams {
  readonly command: string
  readonly reason: string
  readonly author: { readonly agentId: string; readonly authorName: string }
  readonly provenance?: { readonly sessionId: string; readonly userTurns: number; readonly claim?: ClaimReceipt }
  readonly [field: string]: unknown
}
export declare function runMemoryTool(options: { repo: GitMemoryRepo; lock: MemoryToolLock; params: MemoryToolParams }): Promise<{
  readonly message: string
  readonly commit?: { readonly sha: string; readonly subject: string; readonly affectedPaths: readonly string[] }
}>
export declare class MemoryToolError extends Error {}
export declare function withLock<T>(path: string, record: unknown, operation: () => Promise<T>, options?: { waitTimeoutMs?: number }): Promise<T>
export declare function createLockRecord(label: string): Promise<unknown>
export declare function memoryWriterLockPath(locksDir: string): string
export declare function buildDefaultSeedFiles(): readonly unknown[]
export declare function installHooks(repoPath: string, options?: { checker?: { execPath: string; script: string } }): unknown

export interface ProjectedChanges {
  readonly added: readonly string[]
  readonly updated: readonly string[]
  readonly removed: readonly string[]
}
export declare function projectedChangesBetween(
  repo: GitMemoryRepo,
  base: string | null,
  head: string | null,
  options?: { excludeSessionId?: string },
): Promise<ProjectedChanges>
export declare function isEmptyProjectedChanges(changes: ProjectedChanges): boolean
export declare function renderProjectedChangesLine(changes: ProjectedChanges, pinnedRevision: string | null): string

export declare function getPlanChecklist(planPath: string): {
  readonly completed: number
  readonly remaining: number
  readonly total: number
  readonly nextTaskLabel: string | null
}
