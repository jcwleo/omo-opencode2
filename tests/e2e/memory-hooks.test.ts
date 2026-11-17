import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Sandbox } from "./harness.ts"

// The memory engine against hooks left by another omo version; no OpenCode server is needed for these writes.
setDefaultTimeout(60_000)

let box: Sandbox
let repo = ""
let hook = ""

async function status(): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repo, "status", "--porcelain"], { stdout: "pipe", stderr: "pipe" })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return out
}

function hookKeys(): string {
  return /^ALL_KNOWN_KEYS="([^"]*)"/m.exec(readFileSync(hook, "utf8"))?.[1] ?? ""
}

beforeAll(async () => {
  box = await Sandbox.create()
  await box.externalMemoryWrite({ command: "create", file_path: "notes/seeded.md", description: "seeded note", file_text: "SEEDED\n" })
  repo = box.memoryIdentity().paths.repo
  hook = join(repo, ".git", "hooks", "pre-commit")
})

afterAll(async () => {
  await box.dispose()
})

describe("memory hooks", () => {
  test("a hook that predates the provenance key is refreshed before the commit", async () => {
    writeFileSync(hook, readFileSync(hook, "utf8").replace(/^ALL_KNOWN_KEYS="[^"]*"/m, 'ALL_KNOWN_KEYS="description read_only limit kind aliases"'))
    const message = await box.externalMemoryWrite({ command: "create", file_path: "notes/after-stale.md", description: "written after a stale hook", file_text: "AFTER\n" })
    expect(message).toContain("committed")
    expect(hookKeys().split(" ")).toContain("provenance")
    expect(await status()).toBe("")
  })

  test("a rejected commit is rolled back, and a newer hook is left as it is", async () => {
    const newer = `#!/bin/sh\nALL_KNOWN_KEYS="description read_only limit kind aliases provenance expires"\necho "REJECTED-BY-NEWER-HOOK"\nexit 1\n`
    writeFileSync(hook, newer)
    const failure = await box.externalMemoryWrite({ command: "str_replace", file_path: "notes/seeded.md", old_string: "SEEDED", new_string: "CHANGED", reason: "edit" }).then(
      () => undefined,
      (error: unknown) => String(error),
    )
    expect(failure).toContain("REJECTED-BY-NEWER-HOOK")
    expect(readFileSync(hook, "utf8")).toBe(newer)
    expect(await status()).toBe("")
    expect(readFileSync(join(repo, "notes/seeded.md"), "utf8")).toContain("SEEDED")
  })
})
