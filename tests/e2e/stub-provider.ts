import { existsSync, readFileSync } from "node:fs"
import { textOf, type ChatBody, type ChatMessage } from "./harness.ts"

export type StubCall = { readonly name: string; readonly args: Record<string, unknown> }
export type StubReply = { readonly text: string } | { readonly call: StubCall }

export interface StubProvider {
  readonly baseURL: string
  stop(): Promise<void>
}

export const STUB_ENV: Readonly<Record<string, string>> = { STUB_API_KEY: "unused" }

export function stubProviderConfig(baseURL: string, modelIds: readonly string[]): Record<string, unknown> {
  return {
    name: "Stub",
    env: Object.keys(STUB_ENV),
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL },
    models: Object.fromEntries(modelIds.map((id) => [id, { name: id }])),
  }
}

function sse(deltas: readonly Record<string, unknown>[]): Response {
  const frames = deltas.map((delta, index) =>
    `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, ...delta }], ...(index === deltas.length - 1 ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })}\n\n`,
  )
  return new Response(`${frames.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
}

export function startStubProvider(respond: (body: ChatBody) => StubReply): StubProvider {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions")) return Response.json({ data: [] })
      const reply = respond((await request.json()) as ChatBody)
      if ("call" in reply) {
        const call = { index: 0, id: `call_${crypto.randomUUID()}`, type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }
        return sse([{ delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }, { delta: {}, finish_reason: "tool_calls" }])
      }
      return sse([{ delta: { role: "assistant", content: reply.text }, finish_reason: null }, { delta: {}, finish_reason: "stop" }])
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

function firstText(message: ChatMessage | undefined): string {
  const content = message?.content
  if (content === undefined || content === null) return ""
  if (typeof content === "string") return content
  return content.find((part) => part.type === "text")?.text ?? ""
}

function jsonObjectAt(text: string, start: number): Record<string, unknown> | undefined {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (char === "\\") index++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) return JSON.parse(text.slice(start, index + 1)) as Record<string, unknown>
  }
  return undefined
}

function instruction(text: string, lead: string): StubCall | undefined {
  const match = new RegExp(`${lead}(\\S+) tool exactly once with exactly this JSON input: `).exec(text)
  if (match === null || match[1] === undefined) return undefined
  const args = jsonObjectAt(text, match.index + match[0].length)
  return args === undefined ? undefined : { name: match[1], args }
}

function continuation(directive: string, resultsSinceDirective: number): StubReply {
  const plan = /Plan file: `([^`]+)`/.exec(directive)?.[1]
  if (plan === undefined || !existsSync(plan) || readFileSync(plan, "utf8").includes("- [x] 1.")) return { text: "done" }
  if (resultsSinceDirective === 0) return { call: { name: "write", args: { path: "done.txt", content: "ok\n" } } }
  if (resultsSinceDirective === 1) return { call: { name: "edit", args: { path: plan, oldString: "- [ ] 1.", newString: "- [x] 1." } } }
  return { text: "done" }
}

/**
 * Stands in for a model that follows the live suite's prompts literally: "Call the X tool exactly once with exactly
 * this JSON input: {...}", the deferred "When I answer yes, call the X tool ..." form, "reply with exactly this
 * question: ...", and the ulw-execute continuation's one-checkbox plan.
 */
export function followInstructions(body: ChatBody): StubReply {
  const messages = body.messages
  const userIndex = messages.findLastIndex((message) => message.role === "user")
  const user = messages[userIndex]
  const offered = (name: string): boolean => (body.tools ?? []).some((tool) => tool.function.name === name)
  if (textOf(user?.content).includes("<omo-ulw-execute-continuation>")) {
    return continuation(textOf(user?.content), messages.slice(userIndex + 1).filter((message) => message.role === "tool").length)
  }
  if (messages.at(-1)?.role !== "user") return { text: "done" }
  const text = firstText(user)
  const immediate = instruction(text, "Call the ")
  if (immediate !== undefined && offered(immediate.name)) return { call: immediate }
  if (text.trim() === "yes") {
    const deferred = messages
      .slice(0, userIndex)
      .filter((message) => message.role === "user")
      .map((message) => instruction(firstText(message), "When I answer yes, call the "))
      .findLast((call) => call !== undefined)
    if (deferred !== undefined && offered(deferred.name)) return { call: deferred }
  }
  const question = /reply with exactly this question: (.+)$/.exec(text)?.[1]
  return { text: question ?? "pong" }
}
