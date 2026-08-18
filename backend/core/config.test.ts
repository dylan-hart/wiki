import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import configSvc from './config.ts'

/**
 * Regression test for `config.init()`'s DB_PASS_FILE (Docker secret) handling: `.trim()` was called
 * on the *Promise* returned by `fs.readFile(...)` rather than on the resolved string, so every read
 * threw `promise.trim is not a function` — the `catch` block always ran and `process.exit(1)` killed
 * the process. Fixed by awaiting the read before calling `.trim()`.
 *
 * `WIKI.ROOTPATH`/`WIKI.SERVERPATH` point at a throwaway fixture directory rather than the real repo
 * files, so this stays a self-contained unit test of `init()`'s DB_PASS_FILE branch instead of also
 * exercising the real `config.yml`/`base.yml` contents.
 */

let dir: string
let dbPassFile: string
let previousWiki: any
let previousDbPassFile: string | undefined
let previousExit: typeof process.exit

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wikijs-config-test-'))

  await writeFile(
    path.join(dir, 'base.yml'),
    'defaults:\n  config:\n    port: 80\n    db:\n      host: localhost\n      pass: basedefaultpass\n'
  )
  await writeFile(path.join(dir, 'config.yml'), 'port: 3000\n')
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ version: '0.0.0-test', releaseDate: '2026-01-01', dev: true })
  )

  // Trailing newline, as a real Docker secret file (or `echo pass > file`) would produce — this is
  // what proves the fix actually trims the resolved string rather than just reading it.
  dbPassFile = path.join(dir, 'db-pass.txt')
  await writeFile(dbPassFile, 'sup3rSecret\n')

  previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = { ROOTPATH: dir, SERVERPATH: dir }

  previousDbPassFile = process.env.DB_PASS_FILE
  process.env.DB_PASS_FILE = dbPassFile

  // Pre-fix, the bug's catch block calls process.exit(1) — guard against actually killing the test
  // runner and instead surface it as a thrown assertion failure.
  previousExit = process.exit
  ;(process as any).exit = (code?: number) => {
    throw new Error(`process.exit(${code}) called — DB_PASS_FILE read/trim threw`)
  }
})

after(async () => {
  ;(globalThis as any).WIKI = previousWiki
  process.exit = previousExit
  if (previousDbPassFile === undefined) {
    delete process.env.DB_PASS_FILE
  } else {
    process.env.DB_PASS_FILE = previousDbPassFile
  }
  await rm(dir, { recursive: true, force: true })
})

test('reads and trims the DB_PASS_FILE contents into WIKI.config.db.pass', async () => {
  await configSvc.init(true)

  const wiki = (globalThis as any).WIKI
  assert.equal(wiki.config.db.pass, 'sup3rSecret')
})
