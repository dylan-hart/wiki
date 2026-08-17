import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { localeCode, computeCompleteness } from './locales.ts'
import { locales as localesTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

// -> `refreshFromDisk()` compares mtimes via the native `Temporal` API (`Date#toTemporalInstant()` +
//    `Temporal.Instant.compare()`), per CLAUDE.md's "Backend patterns". That is only a runtime global
//    on Node 26+; this sandbox's Node is 25.9 (a pre-existing, already-documented mismatch — see
//    feature 410's continuity notes), where both are simply absent and every `stat()` result would
//    otherwise throw and get misreported as "not found on disk". Feature-detected so this is a no-op
//    wherever the real thing already exists (Node 26+, i.e. everywhere this actually ships).
if (typeof Temporal === 'undefined') {
  class FakeInstant {
    epochMs: number
    constructor(epochMs: number) {
      this.epochMs = epochMs
    }
  }
  ;(globalThis as any).Temporal = {
    Instant: { compare: (a: FakeInstant, b: FakeInstant) => a.epochMs - b.epochMs }
  }
  if (!(Date.prototype as any).toTemporalInstant) {
    ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
      return new FakeInstant(this.getTime())
    }
  }
}

/**
 * `refreshFromDisk` (see `locales.ts`) logs a `[ SKIPPED ]` warning at boot for every language
 * declared in `locales/metadata.js` that has no matching `backend/locales/<code>.json` file on
 * disk. This is a pure, no-`WIKI`, no-database check of that exact invariant: every declared
 * language resolves to a real file. It is what "a fresh boot produces zero [ SKIPPED ] locale
 * warnings" (task 690's stated done-condition) reduces to, without needing to actually boot.
 */
describe('locales metadata <-> vendored files', () => {
  const localesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../locales')

  test('every language in metadata.js has a matching backend/locales/<code>.json file', async () => {
    const { default: localesMeta } = await import('../locales/metadata.js')

    const missing = localesMeta.languages
      .map((lang) => localeCode(lang))
      .filter((code) => !existsSync(path.join(localesDir, `${code}.json`)))

    assert.deepEqual(missing, [], `missing strings files for: ${missing.join(', ')}`)
  })

  test('declares at least 40 languages, including the six previously-committed ones', async () => {
    const { default: localesMeta } = await import('../locales/metadata.js')
    const codes = new Set(localesMeta.languages.map((lang) => localeCode(lang)))

    assert.ok(
      localesMeta.languages.length >= 40,
      `expected at least 40 languages, got ${localesMeta.languages.length}`
    )
    for (const required of ['de', 'en', 'fr', 'pt-BR', 'ru', 'zh-Hans']) {
      assert.ok(codes.has(required), `expected metadata.js to still declare ${required}`)
    }
  })

  test('every language has a distinct code and a pluralType function (shape-compatibility)', async () => {
    const { default: localesMeta } = await import('../locales/metadata.js')
    const codes = localesMeta.languages.map((lang) => localeCode(lang))

    assert.equal(new Set(codes).size, codes.length, 'expected no duplicate language codes')
    for (const lang of localesMeta.languages) {
      assert.equal(typeof lang.pluralType, 'function', `${localeCode(lang)} is missing pluralType`)
      assert.equal(typeof lang.pluralType(1), 'string')
    }
  })

  test('localeCode() builds language[-region][-script]', () => {
    assert.equal(localeCode({ language: 'de', region: '', script: '' }), 'de')
    assert.equal(localeCode({ language: 'pt', region: 'BR', script: '' }), 'pt-BR')
    assert.equal(localeCode({ language: 'zh', region: '', script: 'Hans' }), 'zh-Hans')
  })
})

/**
 * `computeCompleteness()` (see `locales.ts`) is the pure percentage calculation `refreshFromDisk`
 * uses for the `completeness` column: `Math.round(100 * matchingNonEmptyKeys / totalBaseKeys)`,
 * counting a base key present only when the target also has it as a non-empty string. Tested directly
 * against small fixture objects rather than through `refreshFromDisk`'s disk/DB machinery.
 */
describe('computeCompleteness()', () => {
  test('a locale file missing half its keys yields ~50', () => {
    const base = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`key${i}`, `value${i}`]))
    const target = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`key${i}`, `translated${i}`])
    )
    assert.equal(computeCompleteness(base, target), 50)
  })

  test('the base locale compared against itself reads 100', () => {
    const base = { a: 'one', b: 'two', c: 'three' }
    assert.equal(computeCompleteness(base, base), 100)
  })

  test('a present-but-empty-string key does not count as translated', () => {
    const base = { a: 'one', b: 'two' }
    const target = { a: 'translated', b: '' }
    assert.equal(computeCompleteness(base, target), 50)
  })

  test('a missing key does not count as translated', () => {
    const base = { a: 'one', b: 'two' }
    const target = { a: 'translated' }
    assert.equal(computeCompleteness(base, target), 50)
  })

  test('an empty base locale reads 100 (nothing to translate)', () => {
    assert.equal(computeCompleteness({}, {}), 100)
  })
})

/**
 * `refreshFromDisk()` DB-backed: confirms `completeness` is actually persisted through the real
 * insert/onConflictDoUpdate call (not just computed and dropped), and that the mtime-based skip path
 * leaves the previously-computed value in place rather than resetting it — the "intentionally left as
 * the last-computed value" option task 692 explicitly allows for a run that does no disk/DB work.
 *
 * Uses a scratch `locales/` directory (not the real vendored files) pointed to via `WIKI.SERVERPATH`,
 * with `metadata.js`'s real `de` entry (filename `de.json`, no region/script) as the one language
 * under test — every other real declared language simply misses its `stat()` and is skipped, exactly
 * like `locales.test.ts`'s existing coverage of that path.
 */
describe('refreshFromDisk() completeness (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let refreshFromDisk: (typeof import('./locales.ts').locales)['refreshFromDisk']
  let scratchDir: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({
      locales: { refreshFromDisk }
    } = await import('./locales.ts'))

    scratchDir = await mkdtemp(path.join(tmpdir(), 'wiki-locales-test-'))
    await mkdir(path.join(scratchDir, 'locales'), { recursive: true })

    const baseStrings = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`key${i}`, `value${i}`])
    )
    await writeFile(path.join(scratchDir, 'locales/en.json'), JSON.stringify(baseStrings))
    // -> `de` translates exactly half of the base keys.
    const deStrings = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`key${i}`, `wert${i}`])
    )
    await writeFile(path.join(scratchDir, 'locales/de.json'), JSON.stringify(deStrings))

    WIKI.SERVERPATH = scratchDir
  })

  after(async () => {
    await rm(scratchDir, { recursive: true, force: true })
    await teardownTestDb()
  })

  test('persists a ~50% completeness for a half-translated locale', async () => {
    await refreshFromDisk({ force: true })

    const [row] = await fixtures.db
      .select({ completeness: localesTable.completeness })
      .from(localesTable)
      .where(eq(localesTable.code, 'de'))
    assert.ok(row, 'expected a `de` row to have been inserted')
    assert.equal(row!.completeness, 50)
  })

  test('re-running with force:false and no file changes leaves completeness as last computed', async () => {
    // -> Back-date the file so the DB's `updatedAt` (just written above) is unambiguously newer,
    //    exercising the "skip, DB is newer" branch rather than the "reload" branch.
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await utimes(path.join(scratchDir, 'locales/de.json'), past, past)

    await refreshFromDisk({ force: false })

    const [row] = await fixtures.db
      .select({ completeness: localesTable.completeness })
      .from(localesTable)
      .where(eq(localesTable.code, 'de'))
    assert.ok(row, 'expected the `de` row to still exist')
    assert.equal(
      row!.completeness,
      50,
      'skip path must not clear or corrupt the last-computed value'
    )
  })
})
