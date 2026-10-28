import { cp, mkdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const SOURCE = resolve(import.meta.dir, "..", "agents", "omo")

function targetAgentsDir(): string {
  const index = process.argv.indexOf("--target")
  if (index !== -1) {
    const value = process.argv[index + 1]
    if (value === undefined) throw new Error("--target needs an agents directory")
    return resolve(value)
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "agents")
}

async function main(): Promise<void> {
  const destination = join(targetAgentsDir(), "omo")
  await rm(destination, { recursive: true, force: true })
  if (process.argv.includes("--uninstall")) {
    console.log(`removed ${destination}`)
    return
  }
  if (!(await stat(SOURCE).catch(() => undefined))?.isDirectory()) throw new Error(`${SOURCE} is missing; run \`bun run sync:agents\` first`)
  await mkdir(destination, { recursive: true })
  await cp(SOURCE, destination, { recursive: true })
  console.log(`installed omo agents into ${destination}`)
}

await main()
