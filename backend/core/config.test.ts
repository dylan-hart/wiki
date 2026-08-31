import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, mock, test } from 'node:test'
import { load } from 'js-yaml'
import configSvc from './config.ts'
import { resolvePoolSizeOptions } from './db.ts'

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
  ;(globalThis as any).WIKI = { ROOTPATH: dir, SERVERPATH: dir, logger: { warn: mock.fn() } }

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

/**
 * OpenProject #2276: `backend/base.yml` used to declare no `pool.max`, so node-postgres' own default
 * of 10 applied silently — a handful of concurrent requests against any unmetered whole-table
 * surface could occupy the pool entirely and queue every other query, logins included, behind them.
 *
 * Two things are asserted here, matching the WP's own "done when": (1) the *real* `backend/base.yml`
 * shipped in this repo declares an explicit `pool.max` above that library default, and (2) a
 * configured `pool.max` genuinely reaches the options `core/db.ts`'s `init()` passes to `new Pool()`
 * — verified through `resolvePoolSizeOptions`, the exact function `init()` calls right before that
 * constructor call, rather than re-deriving the merge separately here and only proving the two
 * happen to agree.
 */
describe('pool.max reaches the Pool() options in db.ts', () => {
  test('the real backend/base.yml declares an explicit pool.max, not the node-postgres default of 10', async () => {
    const realBaseYmlPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'base.yml'
    )
    const parsed = load(await readFile(realBaseYmlPath, 'utf8')) as any
    const realPool = parsed.defaults.config.pool

    assert.equal(typeof realPool.max, 'number')
    assert.ok(
      realPool.max > 10,
      `expected base.yml's pool.max to explicitly override the pg default of 10, got ${realPool.max}`
    )
  })

  let poolDir: string
  let previousPoolWiki: any

  before(async () => {
    poolDir = await mkdtemp(path.join(tmpdir(), 'wikijs-config-pool-test-'))
    await writeFile(
      path.join(poolDir, 'base.yml'),
      'defaults:\n  config:\n    port: 80\n    db:\n      host: localhost\n      pass: basedefaultpass\n    pool:\n      min: 1\n      max: 33\n'
    )
    await writeFile(path.join(poolDir, 'config.yml'), 'port: 3000\n')
    await writeFile(
      path.join(poolDir, 'package.json'),
      JSON.stringify({ version: '0.0.0-test', releaseDate: '2026-01-01', dev: true })
    )

    previousPoolWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { ROOTPATH: poolDir, SERVERPATH: poolDir }
  })

  after(async () => {
    ;(globalThis as any).WIKI = previousPoolWiki
    await rm(poolDir, { recursive: true, force: true })
  })

  test('a configured pool.max flows through WIKI.config.pool into the Pool() constructor options', async () => {
    await configSvc.init(true)

    const wiki = (globalThis as any).WIKI
    assert.deepEqual(wiki.config.pool, { min: 1, max: 33 })

    // -> This is the exact call `init()` makes right before `new Pool({ ...literal, ...options })`
    //    in db.ts — proving the configured value reaches that constructor call, not just WIKI.config.
    assert.deepEqual(resolvePoolSizeOptions(false, wiki.config.pool), { min: 1, max: 33 })

    // -> Worker mode ignores the configured value entirely and pins to a single connection.
    assert.deepEqual(resolvePoolSizeOptions(true, wiki.config.pool), { min: 0, max: 1 })
  })
})

/**
 * Regression coverage for `core/config.ts:60`'s `toMerged(appdata.defaults.config, appconfig)`:
 * previously a mistyped config.yml key (`logLvel:`, `sceduler:`) merged in silently and did nothing.
 * `init()` now walks the parsed config.yml against base.yml's shape and warns once per key with no
 * counterpart there, at any depth.
 */
{
  const baseYml =
    'defaults:\n  config:\n    port: 80\n    logLevel: info\n    db:\n      host: localhost\n      pass: basedefaultpass\n      sslOptions:\n        auto: true\n'

  async function setupFixture(configYml: string) {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'wikijs-config-unknown-keys-test-'))
    await writeFile(path.join(fixtureDir, 'base.yml'), baseYml)
    await writeFile(path.join(fixtureDir, 'config.yml'), configYml)
    await writeFile(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify({ version: '0.0.0-test', releaseDate: '2026-01-01', dev: true })
    )
    return fixtureDir
  }

  test('warns once per unknown config.yml key, at any depth', async () => {
    const fixtureDir = await setupFixture(
      'port: 3000\nlogLvel: debug\ndb:\n  host: myhost\n  sslOptions:\n    autoo: false\n'
    )
    const warn = mock.fn()
    const previous = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { ROOTPATH: fixtureDir, SERVERPATH: fixtureDir, logger: { warn } }

    try {
      await configSvc.init(true)
    } finally {
      ;(globalThis as any).WIKI = previous
      await rm(fixtureDir, { recursive: true, force: true })
    }

    assert.equal(warn.mock.callCount(), 2)
    const messages = warn.mock.calls.map((call) => call.arguments[0])
    assert.ok(messages.some((m: string) => m.includes('logLvel')))
    assert.ok(messages.some((m: string) => m.includes('db.sslOptions.autoo')))
  })

  test('does not warn for a fully-valid config.yml', async () => {
    const fixtureDir = await setupFixture(
      'port: 3000\nlogLevel: debug\ndb:\n  host: myhost\n  sslOptions:\n    auto: false\n'
    )
    const warn = mock.fn()
    const previous = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = { ROOTPATH: fixtureDir, SERVERPATH: fixtureDir, logger: { warn } }

    try {
      await configSvc.init(true)
    } finally {
      ;(globalThis as any).WIKI = previous
      await rm(fixtureDir, { recursive: true, force: true })
    }

    assert.equal(warn.mock.callCount(), 0)
  })
}
