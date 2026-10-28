import { appendFileSync } from "node:fs"

const LOG = process.env.OMO_E2E_PROBE_LOG

function record(entry: Record<string, unknown>): void {
  if (LOG !== undefined) appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
}

const EVENT_TYPES = new Set(["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

export default {
  id: "omo-e2e-probe",
  async setup(ctx: {
    session: {
      hook(name: "http.request", fn: (event: { sessionID: string; agent: string; kind: string; model: { providerID: string; id: string }; request: Request }) => Promise<void>): Promise<void>
      hook(name: "experimental.ws.send", fn: (event: { sessionID: string; agent: string; kind: string; model: { providerID: string; id: string }; frame: string }) => void): Promise<void>
      hook(name: "experimental.ws.receive", fn: (event: { sessionID: string; frame: string }) => void): Promise<void>
    }
    event: { subscribe(options: { signal?: AbortSignal }): AsyncIterable<{ type: string; data?: { sessionID?: string } }> }
  }) {
    await ctx.session.hook("http.request", async (event) => {
      record({
        kind: "request",
        sessionID: event.sessionID,
        agent: event.agent,
        requestKind: event.kind,
        model: `${event.model.providerID}/${event.model.id}`,
        url: event.request.url,
        body: await event.request.clone().text(),
      })
    })
    // ChatGPT sign-ins stream the Responses API over a WebSocket, so their requests surface only as outbound frames.
    await ctx.session.hook("experimental.ws.send", (event) => {
      record({ kind: "request", transport: "ws", sessionID: event.sessionID, agent: event.agent, requestKind: event.kind, model: `${event.model.providerID}/${event.model.id}`, body: event.frame })
    })
    // Those frames carry only new input items, so the model's tool calls are read from what the socket sends back.
    await ctx.session.hook("experimental.ws.receive", (event) => {
      if (!event.frame.includes('"function_call"')) return
      try {
        const parsed = JSON.parse(event.frame) as { type?: string; item?: { type?: string; call_id?: string; name?: string; arguments?: string } }
        const item = parsed.item
        if (parsed.type === "response.output_item.done" && item?.type === "function_call") {
          record({ kind: "ws-call", sessionID: event.sessionID, callID: item.call_id, name: item.name, arguments: item.arguments })
        }
      } catch (error) {
        record({ kind: "probe-error", sessionID: event.sessionID, error: String(error), frame: event.frame.slice(0, 400) })
      }
    })
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (EVENT_TYPES.has(event.type)) record({ kind: "event", type: event.type, sessionID: event.data?.sessionID })
      }
    })().catch(() => undefined)
    return () => controller.abort()
  },
}
