import { NOT_AFTER_IDENTIFIER, NOT_BEFORE_PATH, NOT_INTO_IDENTIFIER, stripQuotedRegions } from "./strip-quoted-regions.ts"

const ULTRAWORK_PATTERN = new RegExp(String.raw`${NOT_AFTER_IDENTIFIER}\b(?:ultrawork|ulw)\b${NOT_INTO_IDENTIFIER}${NOT_BEFORE_PATH}`, "i")

const skillNamePattern = (body: string): RegExp =>
  new RegExp(String.raw`${NOT_AFTER_IDENTIFIER}\b${body}\b${NOT_INTO_IDENTIFIER}${NOT_BEFORE_PATH}`, "i")

export interface SkillPointer {
  readonly skill: string
  readonly instruction: string
  readonly companions: readonly string[]
}

const POINTERS: readonly (SkillPointer & { readonly pattern: RegExp })[] = [
  {
    skill: "ulw-plan",
    pattern: skillNamePattern(String.raw`ulw[\s-]*plan`),
    instruction: "run the explore-first planning workflow and produce one decision-complete work plan",
    companions: [],
  },
  {
    skill: "ulw-research",
    pattern: skillNamePattern(String.raw`ulw[\s-]*research`),
    instruction: "orchestrate team-first maximum-saturation research",
    companions: ["browser", "ultimate-browsing"],
  },
]

export function isUltraworkRequest(text: string): boolean {
  return ULTRAWORK_PATTERN.test(stripQuotedRegions(text))
}

export function matchSkillPointers(text: string): SkillPointer[] {
  const visible = stripQuotedRegions(text)
  return POINTERS.filter((pointer) => pointer.pattern.test(visible))
}

export function renderSkillPointer(pointer: SkillPointer): string {
  const companions =
    pointer.companions.length === 0
      ? ""
      : ` Its lanes run on ${pointer.companions.map((name) => `\`${name}\``).join(" and ")}: load those skills in the same turn and tell every lane subagent to load them too.`
  return [
    `<omo-${pointer.skill}-pointer>`,
    `This message mentions ${pointer.skill}. If the user of this session is asking to run ${pointer.skill}, load the \`${pointer.skill}\` skill with the skill tool before any other tool call and ${pointer.instruction}.${companions}`,
    `If ${pointer.skill} is only being discussed, quoted, or relayed from another session, ignore this pointer.`,
    `</omo-${pointer.skill}-pointer>`,
  ].join("\n")
}
