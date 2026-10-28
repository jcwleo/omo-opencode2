import { cp, mkdir, readdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import {
  applyGenericRewrites,
  insertCompatibilityBanner,
  mentionsForeignTools,
  removeSectionUntilNextHeading,
  stripHarnessBanners,
  stripUltraworkVariantMarkers,
} from "./adapt-skill.ts"
import { ULTRAWORK_ASTRA_SKILL, ULTRAWORK_SKILL } from "../src/skills/ids.ts"
import { PORTED_SKILLS, UNSUPPORTED_SKILLS, type SkillSource } from "./skill-manifest.ts"
import { SKILL_OVERLAYS, type Overlay } from "./skill-overlays.ts"

const PROJECT_ROOT = resolve(import.meta.dir, "..")
const TARGET_ROOT = join(PROJECT_ROOT, "skills")
const DEFAULT_SENPI_ROOT = join(homedir(), ".bun/install/global/node_modules/omo-ai/plugin/skills")
const DEFAULT_FORK_PACKAGES = join(homedir(), "Projects/omo-fork/oh-my-openagent/packages")
const DEFAULT_SHARED_ROOT = join(DEFAULT_FORK_PACKAGES, "shared-skills/skills")
const ULTRAWORK_ASTRA_DESCRIPTION =
  "GPT-6 Astra variant of the `ultrawork` directive. The plugin does not register it as a skill; it swaps this body in for `ultrawork` whenever a request runs on GPT-6 Astra."
const SKIPPED_NAMES = new Set(["node_modules", "__pycache__", ".pytest_cache", ".DS_Store"])

function flagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined) throw new Error(`${flag} needs a directory`)
  return value
}

async function requireDirectory(path: string, hint: string): Promise<string> {
  const info = await stat(path).catch(() => undefined)
  if (info?.isDirectory() !== true) throw new Error(`${path} is not a directory; ${hint}`)
  return path
}

async function packageVersion(skillsRoot: string): Promise<string | undefined> {
  const manifest = Bun.file(join(dirname(dirname(skillsRoot)), "package.json"))
  if (!(await manifest.exists())) return undefined
  const pkg: unknown = await manifest.json()
  if (typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string") return pkg.version
  return undefined
}

function countOccurrences(text: string, needle: string): number {
  let count = 0
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) count++
  return count
}

function applyOverlay(text: string, overlay: Overlay): string {
  if ("section" in overlay) {
    if (!text.includes(overlay.section)) throw new Error(`overlay for ${overlay.file}: section "${overlay.section}" not found`)
    const start = text.indexOf(overlay.section)
    const withoutSection = removeSectionUntilNextHeading(text, overlay.section)
    return withoutSection.slice(0, start) + overlay.with + withoutSection.slice(start)
  }
  const expected = overlay.count ?? 1
  const found = countOccurrences(text, overlay.replace)
  if (found !== expected) throw new Error(`overlay for ${overlay.file}: expected ${expected} match(es) of "${overlay.replace.slice(0, 80)}", found ${found}`)
  return text.split(overlay.replace).join(overlay.with)
}

async function adaptSkillDirectory(name: string, skillDir: string, appliedOverlays: Set<Overlay>, overlaySkill: string = name): Promise<void> {
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: skillDir, absolute: true, onlyFiles: true }))
  const markdownCorpus: string[] = []
  for (const path of files.filter((file) => file.endsWith(".md"))) markdownCorpus.push(await Bun.file(path).text())
  const skillNeedsBanner = mentionsForeignTools(markdownCorpus.join("\n"))

  for (const path of files) {
    const fileKey = `${overlaySkill}/${relative(skillDir, path)}`
    const overlays = SKILL_OVERLAYS.filter((overlay) => overlay.file === fileKey)
    const isMarkdown = path.endsWith(".md")
    if (!isMarkdown && overlays.length === 0) continue

    const original = await Bun.file(path).text()
    let content = original
    let hadSenpiBanner = false
    if (isMarkdown) ({ content, hadSenpiBanner } = stripHarnessBanners(content))
    for (const overlay of overlays) {
      content = applyOverlay(content, overlay)
      appliedOverlays.add(overlay)
    }
    if (isMarkdown) {
      content = applyGenericRewrites(content)
      const isSkillFile = basename(path) === "SKILL.md" && dirname(path) === skillDir
      if (isSkillFile && name === "ultrawork") content = stripUltraworkVariantMarkers(content)
      if ((isSkillFile && skillNeedsBanner) || hadSenpiBanner) content = insertCompatibilityBanner(content)
    }
    if (content !== original) await Bun.write(path, content)
  }
}

type TransformDirective = (rawSkill: string, astraVariant?: string) => string

async function writeUltraworkAstraVariant(senpiRoot: string, forkPackages: string, appliedOverlays: Set<Overlay>): Promise<void> {
  const { transformDirective }: { transformDirective: TransformDirective } = await import(join(forkPackages, "omo-senpi/plugin/scripts/embed-directive.mjs"))
  const source = join(senpiRoot, ULTRAWORK_SKILL)
  const directive = transformDirective(await Bun.file(join(source, "SKILL.md")).text(), await Bun.file(join(source, "references/astra-variant.md")).text())
  const target = join(TARGET_ROOT, ULTRAWORK_ASTRA_SKILL)
  await cp(source, target, { recursive: true, filter: (path) => !SKIPPED_NAMES.has(basename(path)) })
  await Bun.write(join(target, "SKILL.md"), `---\nname: ${ULTRAWORK_ASTRA_SKILL}\ndescription: ${JSON.stringify(ULTRAWORK_ASTRA_DESCRIPTION)}\n---\n\n${directive}`)
  await adaptSkillDirectory(ULTRAWORK_ASTRA_SKILL, target, appliedOverlays, ULTRAWORK_SKILL)
}

async function main(): Promise<void> {
  const forkPackages = resolve(flagValue("--fork") ?? process.env.OMO_FORK_PACKAGES ?? DEFAULT_FORK_PACKAGES)
  const roots: Record<SkillSource, string> = {
    senpi: await requireDirectory(
      resolve(flagValue("--senpi") ?? process.env.OMO_SENPI_SKILLS_DIR ?? DEFAULT_SENPI_ROOT),
      "pass --senpi <omo-ai plugin/skills dir> or set OMO_SENPI_SKILLS_DIR",
    ),
    shared: await requireDirectory(
      resolve(flagValue("--shared") ?? process.env.OMO_SHARED_SKILLS_DIR ?? DEFAULT_SHARED_ROOT),
      "pass --shared <shared-skills/skills dir> or set OMO_SHARED_SKILLS_DIR",
    ),
  }

  const senpiSkills = (await readdir(roots.senpi, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const unlisted = senpiSkills.filter((name) => !(name in PORTED_SKILLS) && !(name in UNSUPPORTED_SKILLS))
  if (unlisted.length > 0) throw new Error(`skills in ${roots.senpi} missing from scripts/skill-manifest.ts: ${unlisted.join(", ")}`)

  await rm(TARGET_ROOT, { recursive: true, force: true })
  await mkdir(TARGET_ROOT, { recursive: true })

  const appliedOverlays = new Set<Overlay>()
  for (const [name, source] of Object.entries(PORTED_SKILLS)) {
    const from = join(roots[source], name)
    await requireDirectory(from, `ported skill ${name} is missing from its ${source} source`)
    const target = join(TARGET_ROOT, name)
    await cp(from, target, { recursive: true, filter: (path) => !SKIPPED_NAMES.has(basename(path)) && !path.endsWith(".pyc") })
    await adaptSkillDirectory(name, target, appliedOverlays)
  }

  await writeUltraworkAstraVariant(roots.senpi, forkPackages, appliedOverlays)

  const unapplied = SKILL_OVERLAYS.filter((overlay) => !appliedOverlays.has(overlay)).map((overlay) => overlay.file)
  if (unapplied.length > 0) throw new Error(`overlays whose file was not synced: ${[...new Set(unapplied)].join(", ")}`)

  // SYNC.json is committed, so it names the sources relative to HOME instead of this machine's absolute paths.
  const homeRelative = (path: string): string => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path)
  const record = {
    sources: Object.fromEntries(Object.entries(roots).map(([name, path]) => [name, homeRelative(path)])),
    senpiVersion: await packageVersion(roots.senpi),
    ported: PORTED_SKILLS,
    generated: [ULTRAWORK_ASTRA_SKILL],
    unsupported: UNSUPPORTED_SKILLS,
  }
  await Bun.write(join(TARGET_ROOT, "SYNC.json"), JSON.stringify(record, null, 2) + "\n")
  console.log(`synced ${Object.keys(PORTED_SKILLS).length} skills into ${TARGET_ROOT} (${appliedOverlays.size} overlays)`)
}

await main()
