import type { Message } from "@opencode/ai"
import { Skill, type Plugin } from "@opencode/plugin"
import { ULTRAWORK_ASTRA_SKILL, ULTRAWORK_SKILL } from "../skills/ids.ts"
import { isUltraworkRequest, matchSkillPointers, renderSkillPointer } from "./keywords.ts"
import { isGpt6AstraModel } from "./model-variants.generated.js"

// omo-senpi's re-arm nudge: a session whose transcript already holds the directive gets this line instead of the full text again.
const ULTRAWORK_REMINDER =
  "<omo-ultrawork-reminder>ultrawork mode is already armed for this session - the ultrawork directive above remains binding; re-read it and continue.</omo-ultrawork-reminder>"

type UltraworkVariants = { readonly base: string; readonly astra: string }

function ultraworkVariants(skills: readonly Skill.Info[]): UltraworkVariants | undefined {
  const body = (id: string): string | undefined => skills.find((skill) => String(skill.id) === id)?.content.trim()
  const base = body(ULTRAWORK_SKILL)
  const astra = body(ULTRAWORK_ASTRA_SKILL)
  return base === undefined || astra === undefined ? undefined : { base, astra }
}

function swapText(text: string, from: string, to: string): string {
  return text.includes(from) ? text.replaceAll(from, () => to) : text
}

function withDirective(message: Message, from: string, to: string): Message {
  let changed = false
  const content = message.content.map((part) => {
    if (part.type === "text") {
      const text = swapText(part.text, from, to)
      if (text === part.text) return part
      changed = true
      return { ...part, text }
    }
    if (part.type === "tool-result" && part.result.type === "text" && typeof part.result.value === "string") {
      const value = swapText(part.result.value, from, to)
      if (value === part.result.value) return part
      changed = true
      return { ...part, result: { ...part.result, value } }
    }
    return part
  })
  if (!changed) return message
  const MessageClass = message.constructor as unknown as new (fields: Message) => Message
  return new MessageClass({ ...message, content })
}

export async function registerPromptHooks(ctx: Plugin.Context, skills: readonly Skill.Info[]): Promise<void> {
  const skillIds = new Set(skills.map((skill) => String(skill.id)))
  const variants = ultraworkVariants(skills)
  const armedSessions = new Set<string>()
  const turnNotes = new Map<string, string>()

  await ctx.session.hook("prompt", async (event) => {
    turnNotes.delete(event.sessionID)
    const session = await ctx.session.get({ sessionID: event.sessionID })
    if (session.parentID !== undefined) return

    const text = event.prompt.text
    const attached = new Set((event.prompt.skills ?? []).map((skill) => String(skill.id)))
    const notes: string[] = []

    if (attached.has(ULTRAWORK_SKILL)) {
      armedSessions.add(event.sessionID)
    } else if (skillIds.has(ULTRAWORK_SKILL) && isUltraworkRequest(text)) {
      if (armedSessions.has(event.sessionID)) {
        notes.push(ULTRAWORK_REMINDER)
      } else {
        event.prompt.skills = [...(event.prompt.skills ?? []), { id: Skill.ID.make(ULTRAWORK_SKILL) }]
        attached.add(ULTRAWORK_SKILL)
        armedSessions.add(event.sessionID)
      }
    }

    const pointers = matchSkillPointers(text).filter((pointer) => skillIds.has(pointer.skill) && !attached.has(pointer.skill))
    notes.push(...pointers.map(renderSkillPointer))
    if (notes.length > 0) turnNotes.set(event.sessionID, notes.join("\n\n"))
  })

  await ctx.session.hook("compaction", (event) => {
    armedSessions.delete(event.sessionID)
  })

  await ctx.session.hook("context", (event) => {
    const notes = turnNotes.get(event.sessionID)
    if (notes !== undefined) event.system.push({ type: "text", text: notes })
    if (variants === undefined) return
    const [from, to] = isGpt6AstraModel(event.model.id) ? [variants.base, variants.astra] : [variants.astra, variants.base]
    event.messages.forEach((message, index) => {
      event.messages[index] = withDirective(message, from, to)
    })
  })
}
