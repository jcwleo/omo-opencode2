export declare function resolvePresetName(input: { providerID: string; modelID: string; name?: string }): string | undefined
export declare function isGpt6AstraModel(model: string | undefined): boolean
export declare function categoryPromptAppend(category: string, modelId: string | undefined): string | undefined
export declare function buildPreset(
  name: string,
  options: {
    cwd: string
    selectedTools: string[]
    toolSnippets: Record<string, string>
    promptGuidelines: string[]
    contextFiles: { path: string; content: string }[]
    skills: unknown[]
    surface: "terminal"
    appName?: string
  },
): { readonly parts: readonly { readonly name: string; readonly text: string }[] }
