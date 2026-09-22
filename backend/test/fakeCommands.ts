import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface FakeCommands {
  dir: string
  restore(): Promise<void>
}

function setPath(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.PATH
  } else {
    process.env.PATH = value
  }
}

/**
 * Shell-script stand-ins for system binaries, placed ahead of the real `PATH` so they win over a
 * developer machine that has the genuine article. POSIX only, like the binaries they replace.
 */
export async function installFakeCommands(scripts: Record<string, string>): Promise<FakeCommands> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cardinaljs-fake-commands-'))
  for (const [name, body] of Object.entries(scripts)) {
    const file = path.join(dir, name)
    await writeFile(file, `#!/bin/sh\n${body}\n`)
    await chmod(file, 0o755)
  }
  const previous = process.env.PATH
  process.env.PATH = previous ? `${dir}${path.delimiter}${previous}` : dir
  return {
    dir,
    async restore() {
      setPath(previous)
      await rm(dir, { recursive: true, force: true })
    }
  }
}

/** A `PATH` naming only an empty directory, so no system binary resolves at all. */
export async function withEmptyPath<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cardinaljs-empty-path-'))
  const previous = process.env.PATH
  process.env.PATH = dir
  try {
    return await fn()
  } finally {
    setPath(previous)
    await rm(dir, { recursive: true, force: true })
  }
}
