import type { Message } from "@opencode/ai"
import { Skill, type Plugin } from "@opencode/plugin"
import { CURATION_SOURCE } from "../memory/curation.ts"
import { MessageNotes } from "../omo/message-notes.ts"
import { ULTRAWORK_ASTRA_SKILL, ULTRAWORK_GPT62_SKILL, ULTRAWORK_SKILL } from "../skills/ids.ts"
import { isUltraworkRequest, matchSkillPointers, renderSkillPointer } from "./keywords.ts"
import { isGpt6AstraModel, resolvePresetName } from "./model-variants.generated.js"

// omo-senpi's re-arm nudge: a session whose transcript already holds the directive gets this line instead of the full text again.
const ULTRAWORK_REMINDER =
  "<omo-ultrawork-reminder>ultrawork mode is already armed for this session - the ultrawork directive above remains binding; re-read it and continue.</omo-ultrawork-reminder>"

type UltraworkSkillID = typeof ULTRAWORK_SKILL | typeof ULTRAWORK_ASTRA_SKILL | typeof ULTRAWORK_GPT62_SKILL
type UltraworkVariants = Readonly<Record<UltraworkSkillID, string>>

// GPT-6.2 models follow their own `gpt-6-2` preset. The bundled omo Astra detector only knows the `gpt-6-astra` id, so
// other point releases such as `gpt-6.1-astra` are folded into it.
export function ultraworkSkillFor(modelID: string): UltraworkSkillID {
  if (resolvePresetName({ providerID: "", modelID }) === "gpt-6-2") return ULTRAWORK_GPT62_SKILL
  if (isGpt6AstraModel(modelID.replace(/gpt-6\.\d+-astra/i, "gpt-6-astra"))) return ULTRAWORK_ASTRA_SKILL
  return ULTRAWORK_SKILL
}

function ultraworkVariants(skills: readonly Skill.Info[]): UltraworkVariants | undefined {
  const body = (id: string): string | undefined => skills.find((skill) => String(skill.id) === id)?.content.trim()
  const base = body(ULTRAWORK_SKILL)
  const astra = body(ULTRAWORK_ASTRA_SKILL)
  const gpt62 = body(ULTRAWORK_GPT62_SKILL)
  if (base === undefined || astra === undefined || gpt62 === undefined) return undefined
  return { [ULTRAWORK_SKILL]: base, [ULTRAWORK_ASTRA_SKILL]: astra, [ULTRAWORK_GPT62_SKILL]: gpt62 }
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
  const turnNotes = new MessageNotes()

  await ctx.session.hook("prompt", async (event) => {
    if (event.metadata?.source === CURATION_SOURCE) return
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
    if (notes.length > 0) turnNotes.add(event.sessionID, event.messageID, notes.join("\n\n"))
  })

  await ctx.session.hook("compaction", (event) => {
    armedSessions.delete(event.sessionID)
    turnNotes.clear(event.sessionID)
  })

  await ctx.session.hook("context", (event) => {
    turnNotes.apply(event.sessionID, event.messages)
    if (variants === undefined) return
    const to = variants[ultraworkSkillFor(event.model.id)]
    for (const from of Object.values(variants)) {
      if (from === to) continue
      event.messages.forEach((message, index) => {
        event.messages[index] = withDirective(message, from, to)
      })
    }
  })
}
