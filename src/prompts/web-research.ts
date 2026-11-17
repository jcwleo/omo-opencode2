import type { Plugin } from "@opencode/plugin"

export const WEB_RESEARCH_INSTRUCTIONS = `## Web search and page retrieval

- For general web searches, prefer Exa's web_search_exa when it is available and permitted for the current agent. For page content extraction, prefer Exa's web_fetch_exa under the same condition.
- In Code Mode, discover the Exa tools with search({ namespace: "exa" }) and use the exact returned paths and schemas. The initial catalog may be partial; absence from that catalog alone does not mean Exa is unavailable. Without Code Mode, use the exposed Exa tools directly. Never invent an unavailable tool.
- If Exa is not configured, disconnected, requires authentication, or is denied for this agent, use the existing permitted websearch or webfetch tool instead. If a call fails because of authentication, quota, or service errors, fall back to those tools without repeatedly retrying Exa or requiring the user to sign in. Do not install, configure, or authenticate Exa just to complete the task.
- Keep specialized tools preferred for their purpose, such as Context7 for library documentation and repository tools for source code. Use direct webfetch when raw HTML or a direct HTTP fetch is required, or when Exa's extracted content is insufficient. Honor explicit user tool choices and existing permission restrictions.`

export async function registerWebResearch(ctx: Plugin.Context): Promise<void> {
  await ctx.session.hook("context", (event) => {
    event.system.push({ type: "text", text: WEB_RESEARCH_INSTRUCTIONS })
  })
}
