import type { Message } from "@opencode/ai"

// OpenCode sends a turn note only as long as a hook keeps adding it, and a provider's prompt cache misses from the
// first byte that differs from the request before. So a note stays on the user message it was given to, on every
// later request, instead of riding on whichever message is newest or on the system prompt.
export class MessageNotes {
  private readonly sessions = new Map<string, Map<string, string>>()

  add(sessionID: string, messageID: string, text: string): void {
    const notes = this.sessions.get(sessionID) ?? new Map<string, string>()
    notes.set(messageID, text)
    this.sessions.set(sessionID, notes)
  }

  clear(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  apply(sessionID: string, messages: Message[]): void {
    const notes = this.sessions.get(sessionID)
    if (notes === undefined) return
    messages.forEach((message, index) => {
      const text = message.id === undefined ? undefined : notes.get(message.id)
      if (text === undefined) return
      const MessageClass = message.constructor as unknown as new (fields: Message) => Message
      messages[index] = new MessageClass({ ...message, content: [...message.content, { type: "text", text }] })
    })
  }
}
