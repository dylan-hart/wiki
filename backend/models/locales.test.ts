import { describe, test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { localeCode, computeCompleteness, interpolate, parseSideloadLocalePack } from './locales.ts'
import { locales as localesTable } from '../db/schema.ts'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'

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
 * `interpolate()` — the `{name}`-style placeholder substitution `resolveString()`/
 * `resolvePluralString()` apply to whatever `lookupString()` finds (#1611/#1623).
 */
describe('interpolate()', () => {
  test('substitutes every placeholder present in params', () => {
    assert.equal(
      interpolate('Hi {name}, see {link}', { name: 'Ada', link: '/x' }),
      'Hi Ada, see /x'
    )
  })

  test('leaves a placeholder with no matching param untouched, rather than blanking it', () => {
    assert.equal(interpolate('Hi {name}', {}), 'Hi {name}')
  })

  test('a template with no placeholders is returned as-is', () => {
    assert.equal(interpolate('No placeholders here', { name: 'Ada' }), 'No placeholders here')
  })
})

/**
 * `parseSideloadLocalePack()` (see `locales.ts`, OpenProject #820): the pure validation
 * `sideloadFromDataPath` runs each `<dataPath>/locales/<code>.json` file's parsed content through
 * before it ever touches disk timestamps or the DB. A sideload file is self-contained (no
 * `locales/metadata.js` entry backing it up), so this is what actually enforces its shape.
 */
describe('parseSideloadLocalePack()', () => {
  test('accepts a fully-specified pack', () => {
    const result = parseSideloadLocalePack({
      name: 'Klingon',
      nativeName: 'tlhIngan Hol',
      language: 'tlh',
      region: '',
      script: '',
      isRTL: false,
      strings: { hello: 'nuqneH' }
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.ok ? result.pack : undefined, {
      name: 'Klingon',
      nativeName: 'tlhIngan Hol',
      language: 'tlh',
      region: '',
      script: '',
      isRTL: false,
      strings: { hello: 'nuqneH' }
    })
  })

  test('fills in nativeName, region, script and isRTL defaults when omitted', () => {
    const result = parseSideloadLocalePack({ name: 'Klingon', language: 'tlh', strings: {} })
    assert.equal(result.ok, true)
    assert.deepEqual(result.ok ? result.pack : undefined, {
      name: 'Klingon',
      nativeName: 'Klingon',
      language: 'tlh',
      region: '',
      script: '',
      isRTL: false,
      strings: {}
    })
  })

  test('rejects a non-object', () => {
    const result = parseSideloadLocalePack('not an object')
    assert.equal(result.ok, false)
  })

  test('rejects a pack missing "name"', () => {
    const result = parseSideloadLocalePack({ language: 'tlh', strings: {} })
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /name/)
  })

  test('rejects a pack missing "language"', () => {
    const result = parseSideloadLocalePack({ name: 'Klingon', strings: {} })
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /language/)
  })

  test('rejects a pack missing "strings"', () => {
    const result = parseSideloadLocalePack({ name: 'Klingon', language: 'tlh' })
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /strings/)
  })

  test('rejects a pack whose "strings" is not an object', () => {
    const result = parseSideloadLocalePack({ name: 'Klingon', language: 'tlh', strings: 'nope' })
    assert.equal(result.ok, false)
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

/**
 * `sideloadFromDataPath()` DB-backed (OpenProject #820): the actual disk -> DB path a dropped-in
 * `<dataPath>/locales/<code>.json` file takes, independent of `locales/metadata.js` — a sideload
 * file can name a code the built-in language table has never declared, or override one that is.
 * Each test resets the sideload directory itself so files from one test never leak, force-reloaded,
 * into the next.
 */
describe('sideloadFromDataPath() (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let localesModel: typeof import('./locales.ts').locales
  let scratchDir: string
  let sideloadDir: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ locales: localesModel } = await import('./locales.ts'))

    scratchDir = await mkdtemp(path.join(tmpdir(), 'wiki-sideload-test-'))
    await mkdir(path.join(scratchDir, 'server/locales'), { recursive: true })

    const baseStrings = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`key${i}`, `value${i}`])
    )
    await writeFile(path.join(scratchDir, 'server/locales/en.json'), JSON.stringify(baseStrings))

    WIKI.SERVERPATH = path.join(scratchDir, 'server')
    WIKI.ROOTPATH = scratchDir
    WIKI.config.dataPath = path.join(scratchDir, 'data')
    sideloadDir = path.join(scratchDir, 'data/locales')
  })

  beforeEach(async () => {
    await rm(sideloadDir, { recursive: true, force: true })
    await mkdir(sideloadDir, { recursive: true })
  })

  after(async () => {
    await rm(scratchDir, { recursive: true, force: true })
    await teardownTestDb()
  })

  test('loads a brand-new locale code no metadata.js entry backs', async () => {
    await writeFile(
      path.join(sideloadDir, 'tlh.json'),
      JSON.stringify({
        name: 'Klingon',
        nativeName: 'tlhIngan Hol',
        language: 'tlh',
        strings: { key0: 'wa', key1: 'cha' }
      })
    )

    const result = await localesModel.sideloadFromDataPath({ force: true })
    assert.deepEqual(result.loaded, ['tlh'])
    assert.deepEqual(result.skipped, [])

    const [row] = await fixtures.db.select().from(localesTable).where(eq(localesTable.code, 'tlh'))
    assert.ok(row, 'expected the sideloaded tlh row to exist')
    assert.equal(row!.name, 'Klingon')
    assert.equal(row!.completeness, 50)
  })

  test('updates an existing code, taking priority over what is already in the DB', async () => {
    await seedLocale(fixtures.db, { code: 'de', name: 'German (stale)' })

    await writeFile(
      path.join(sideloadDir, 'de.json'),
      JSON.stringify({
        name: 'German (sideloaded)',
        language: 'de',
        strings: { key0: 'eins', key1: 'zwei', key2: 'drei', key3: 'vier' }
      })
    )

    const result = await localesModel.sideloadFromDataPath({ force: true })
    assert.deepEqual(result.loaded, ['de'])

    const [row] = await fixtures.db.select().from(localesTable).where(eq(localesTable.code, 'de'))
    assert.equal(row!.name, 'German (sideloaded)')
    assert.equal(row!.completeness, 100)
  })

  test('skips a malformed pack and reports why, without touching valid ones', async () => {
    await writeFile(path.join(sideloadDir, 'broken.json'), '{ not valid json')
    await writeFile(
      path.join(sideloadDir, 'fr.json'),
      JSON.stringify({ name: 'French', language: 'fr', strings: { key0: 'un' } })
    )

    const result = await localesModel.sideloadFromDataPath({ force: true })
    assert.deepEqual(result.loaded, ['fr'])
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0]!.code, 'broken')
  })

  test('skips a pack that violates a DB column constraint, without aborting the rest of the scan', async () => {
    // -> Passes `parseSideloadLocalePack`'s shape validation (a string) but is far past `language`'s
    //    `varchar(8)` column limit, so the insert itself is what has to catch this.
    await writeFile(
      path.join(sideloadDir, 'toolong.json'),
      JSON.stringify({ name: 'Too Long', language: 'a'.repeat(20), strings: { key0: 'x' } })
    )
    await writeFile(
      path.join(sideloadDir, 'es.json'),
      JSON.stringify({ name: 'Spanish', language: 'es', strings: { key0: 'uno' } })
    )

    const result = await localesModel.sideloadFromDataPath({ force: true })
    assert.deepEqual(result.loaded, ['es'])
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0]!.code, 'toolong')
    assert.match(result.skipped[0]!.error, /could not be saved/)

    const [row] = await fixtures.db
      .select()
      .from(localesTable)
      .where(eq(localesTable.code, 'toolong'))
    assert.equal(row, undefined, 'the rejected row must not have been inserted')
  })

  test('a missing sideload directory is not an error', async () => {
    const missingRoot = await mkdtemp(path.join(tmpdir(), 'wiki-sideload-missing-'))
    const previousDataPath = WIKI.config.dataPath
    WIKI.config.dataPath = path.join(missingRoot, 'never-created')

    const result = await localesModel.sideloadFromDataPath({ force: true })
    assert.deepEqual(result, { loaded: [], skipped: [] })

    WIKI.config.dataPath = previousDataPath
    await rm(missingRoot, { recursive: true, force: true })
  })
})

/**
 * `isReservedLocaleCode` (task 12 / #994): whether a path segment names an INSTALLED locale, case-
 * insensitively — installed, not merely active on a given site, per the decision doc's item 4: a
 * locale can be activated later, so a page created while it was only installed must already be
 * unreachable-proof.
 */
describe('isReservedLocaleCode (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let localesModel: typeof import('./locales.ts').locales

  before(async () => {
    fixtures = await setupTestDb()
    ;({ locales: localesModel } = await import('./locales.ts'))
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
    await seedLocale(fixtures.db, { code: 'pt-BR' })
  })

  after(async () => {
    await teardownTestDb()
  })

  test('matches an installed code case-insensitively', async () => {
    assert.equal(await localesModel.isReservedLocaleCode('fr'), true)
    assert.equal(await localesModel.isReservedLocaleCode('FR'), true)
    assert.equal(await localesModel.isReservedLocaleCode('Fr'), true)
    assert.equal(await localesModel.isReservedLocaleCode('pt-br'), true)
    assert.equal(await localesModel.isReservedLocaleCode('PT-BR'), true)
  })

  test('returns false for a code that is not installed', async () => {
    assert.equal(await localesModel.isReservedLocaleCode('de'), false)
  })

  test('returns false for an empty segment', async () => {
    assert.equal(await localesModel.isReservedLocaleCode(''), false)
  })
})

/**
 * `resolveString()` / `resolvePluralString()` (#1611/#1623): the server-side resolver
 * `models/mail.ts`'s templates use to address a recipient in `users.prefs.locale` rather than
 * always `en`. `mail.test.ts` exercises these against the real production `mail.*` keys via a
 * lightweight stand-in (kept out of the DB, matching that file's own pure-unit convention); this
 * suite is the one place the resolver itself is proven against a real `locales` row.
 */
describe('resolveString / resolvePluralString (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let localesModel: typeof import('./locales.ts').locales

  before(async () => {
    fixtures = await setupTestDb()
    ;({ locales: localesModel } = await import('./locales.ts'))
    await fixtures.db.insert(localesTable).values({
      code: 'en',
      name: 'English',
      nativeName: 'English',
      language: 'en',
      region: '',
      script: '',
      isRTL: false,
      strings: {
        greeting: 'Hi {name}, welcome to {place}.',
        digest: 'no items | one item | {count} items'
      }
    })
    await fixtures.db.insert(localesTable).values({
      code: 'fr',
      name: 'French',
      nativeName: 'Français',
      language: 'fr',
      region: '',
      script: '',
      isRTL: false,
      strings: {
        // -> 'digest' deliberately absent, and 'blankKey' present but blank, to exercise both
        //    per-key fallback paths against a locale that IS otherwise installed
        greeting: 'Bonjour {name}, bienvenue à {place}.',
        blankKey: ''
      }
    })
  })

  after(async () => {
    await teardownTestDb()
  })

  test('resolves and interpolates a key present in the requested locale', async () => {
    const result = await localesModel.resolveString('fr', 'greeting', {
      name: 'Ada',
      place: 'Paris'
    })
    assert.equal(result, 'Bonjour Ada, bienvenue à Paris.')
  })

  test('falls back to en for a locale not installed at all', async () => {
    const result = await localesModel.resolveString('xx-not-installed', 'greeting', {
      name: 'Ada',
      place: 'Paris'
    })
    assert.equal(result, 'Hi Ada, welcome to Paris.')
  })

  test('falls back to en for a key missing from an otherwise-installed locale', async () => {
    const result = await localesModel.resolveString('fr', 'digest', {})
    assert.equal(result, 'no items | one item | {count} items')
  })

  test('falls back to en for a key present but blank in an otherwise-installed locale', async () => {
    const result = await localesModel.resolveString('fr', 'blankKey', {})
    // -> en has no 'blankKey' either, so this falls all the way through to the key itself
    assert.equal(result, 'blankKey')
  })

  test('a null/undefined locale resolves straight from en', async () => {
    assert.equal(
      await localesModel.resolveString(null, 'greeting', { name: 'Ada', place: 'Paris' }),
      'Hi Ada, welcome to Paris.'
    )
    assert.equal(
      await localesModel.resolveString(undefined, 'greeting', { name: 'Ada', place: 'Paris' }),
      'Hi Ada, welcome to Paris.'
    )
  })

  test('resolvePluralString selects the zero/one/other form by count', async () => {
    assert.equal(await localesModel.resolvePluralString('en', 'digest', 0), 'no items')
    assert.equal(await localesModel.resolvePluralString('en', 'digest', 1), 'one item')
    assert.equal(await localesModel.resolvePluralString('en', 'digest', 2), '2 items')
    assert.equal(await localesModel.resolvePluralString('en', 'digest', 5), '5 items')
  })
})
