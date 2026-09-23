import { describe, test, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq, lt, sql } from 'drizzle-orm'
import {
  localeCode,
  computeCompleteness,
  interpolate,
  parseSideloadLocalePack,
  mergeLocaleStrings
} from './locales.ts'
import { locales as localesTable } from '../db/schema.ts'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'

// -> `refreshFromDisk()` compares file mtimes through `Temporal`.
await ensureTemporal()

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

describe('mergeLocaleStrings()', () => {
  test('overlay wins on a shared key', () => {
    assert.deepEqual(mergeLocaleStrings({ a: 'one', b: 'two' }, { a: 'ONE' }), {
      a: 'ONE',
      b: 'two'
    })
  })

  test('a key the overlay does not mention passes through from base unchanged', () => {
    assert.deepEqual(mergeLocaleStrings({ a: 'one', b: 'two', c: 'three' }, { b: 'TWO' }), {
      a: 'one',
      b: 'TWO',
      c: 'three'
    })
  })

  test('an overlay key absent from base is added', () => {
    assert.deepEqual(mergeLocaleStrings({ a: 'one' }, { z: 'new' }), { a: 'one', z: 'new' })
  })

  test('an empty base merges as if starting from scratch (brand-new locale case)', () => {
    assert.deepEqual(mergeLocaleStrings({}, { a: 'one' }), { a: 'one' })
  })

  test('an empty overlay leaves base untouched', () => {
    assert.deepEqual(mergeLocaleStrings({ a: 'one' }, {}), { a: 'one' })
  })
})

/**
 * Points `CARDINAL.SERVERPATH` at a scratch `locales/` directory rather than the real vendored files.
 * `de` is the language under test because `metadata.js` really declares it with no region or script,
 * so the file is `de.json`; every other declared language misses its `stat()` and is skipped.
 */
describe('refreshFromDisk() completeness (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let refreshFromDisk: (typeof import('./locales.ts').locales)['refreshFromDisk']
  // -> Bound, not destructured: `Locales`'s methods are plain prototype methods, and
  //    `refreshFromDisk` calls `this.invalidateStringsCache()`, so it needs its real receiver.
  let localesModel: typeof import('./locales.ts').locales
  let scratchDir: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ locales: localesModel } = await import('./locales.ts'))
    refreshFromDisk = localesModel.refreshFromDisk.bind(localesModel)

    scratchDir = await mkdtemp(path.join(tmpdir(), 'wiki-locales-test-'))
    await mkdir(path.join(scratchDir, 'locales'), { recursive: true })

    const baseStrings = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`key${i}`, `value${i}`])
    )
    await writeFile(path.join(scratchDir, 'locales/en.json'), JSON.stringify(baseStrings))
    const deStrings = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`key${i}`, `wert${i}`])
    )
    await writeFile(path.join(scratchDir, 'locales/de.json'), JSON.stringify(deStrings))

    CARDINAL.SERVERPATH = scratchDir
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
    // -> Back-date the file so the DB row is unambiguously newer, taking the "skip, DB is newer"
    //    branch rather than the "reload" one.
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

  test('a subsequent refreshFromDisk() invalidates the cached getStrings() result', async () => {
    await refreshFromDisk({ force: true })
    const cached = await localesModel.getStrings('de')
    assert.deepEqual(
      cached,
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`key${i}`, `wert${i}`]))
    )

    const updatedDeStrings = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`key${i}`, `neu${i}`])
    )
    await writeFile(path.join(scratchDir, 'locales/de.json'), JSON.stringify(updatedDeStrings))

    await refreshFromDisk({ force: true })

    const reloaded = await localesModel.getStrings('de')
    assert.deepEqual(
      reloaded,
      updatedDeStrings,
      'expected the cache to have been invalidated by refreshFromDisk(), serving the reloaded strings'
    )
  })

  /**
   * `refreshFromDisk()` decides whether to reload each language off one snapshot SELECT taken at the
   * top of the call, so another writer can make a row fresher after that snapshot but before this
   * write's own turn arrives. `setWhere` moves the freshness check into Postgres, re-evaluated
   * against the row's CURRENT state, which is what makes the interleaving irrelevant.
   */
  test('setWhere guard: a row already fresher than the vendored file is never overwritten, even by an update decided as if it were stale', async () => {
    // -> Stands in for "some other process already wrote a fresher `de` row".
    await fixtures.db
      .insert(localesTable)
      .values({
        code: 'de',
        name: 'Concurrent Writer',
        nativeName: 'Concurrent Writer',
        language: 'de',
        region: '',
        script: '',
        isRTL: false,
        strings: { keep: 'me' },
        completeness: 99
      })
      .onConflictDoUpdate({
        target: localesTable.code,
        set: {
          name: 'Concurrent Writer',
          nativeName: 'Concurrent Writer',
          strings: { keep: 'me' },
          completeness: 99,
          updatedAt: sql`now()`
        }
      })

    const deFileStat = await stat(path.join(scratchDir, 'locales/de.json'))

    // -> The statement shape `refreshFromDisk()`'s per-language loop issues for `de`, reconstructed
    //    rather than called: reproducing the race for real would mean timing this test's DB write
    //    against the loop's own `stat()` I/O, which is how a test becomes flaky.
    await fixtures.db
      .insert(localesTable)
      .values({
        code: 'de',
        name: 'Vendored',
        nativeName: 'Vendored',
        language: 'de',
        region: '',
        script: '',
        isRTL: false,
        strings: { vendored: 'strings' },
        completeness: 5
      })
      .onConflictDoUpdate({
        target: localesTable.code,
        set: { strings: { vendored: 'strings' }, completeness: 5, updatedAt: sql`now()` },
        setWhere: lt(localesTable.updatedAt, deFileStat.mtime)
      })

    const [row] = await fixtures.db.select().from(localesTable).where(eq(localesTable.code, 'de'))
    assert.deepEqual(
      row!.strings,
      { keep: 'me' },
      'the guarded update must be a no-op against a row already fresher than the file'
    )
    assert.equal(row!.completeness, 99)
    assert.equal(row!.name, 'Concurrent Writer')
  })
})

/**
 * `beforeEach` resets the sideload directory so a file never leaks into the next test, and clears
 * the `locales` table too: a sideload merges onto whatever a code's `strings` column already holds,
 * so a code reused across tests (`de`, `tlh`, ...) would otherwise merge onto a leftover row.
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

    CARDINAL.SERVERPATH = path.join(scratchDir, 'server')
    CARDINAL.ROOTPATH = scratchDir
    CARDINAL.config.dataPath = path.join(scratchDir, 'data')
    sideloadDir = path.join(scratchDir, 'data/locales')
  })

  beforeEach(async () => {
    await rm(sideloadDir, { recursive: true, force: true })
    await mkdir(sideloadDir, { recursive: true })
    await fixtures.db.delete(localesTable)
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

  // -> The seeded row stands in for "an earlier Localazy sync already populated this locale".
  test('a partial sideload merges onto the existing stored strings, leaving other keys untouched', async () => {
    await fixtures.db.insert(localesTable).values({
      code: 'de',
      name: 'German',
      nativeName: 'Deutsch',
      language: 'de',
      region: '',
      script: '',
      isRTL: false,
      strings: { key0: 'eins', key1: 'zwei', key2: 'drei', key3: 'vier' },
      completeness: 100
    })

    await writeFile(
      path.join(sideloadDir, 'de.json'),
      JSON.stringify({
        name: 'German',
        language: 'de',
        strings: { key0: 'EINS (customized)' }
      })
    )

    const result = await localesModel.sideloadFromDataPath({ force: true })
    assert.deepEqual(result.loaded, ['de'])

    const [row] = await fixtures.db.select().from(localesTable).where(eq(localesTable.code, 'de'))
    assert.deepEqual(
      row!.strings,
      { key0: 'EINS (customized)', key1: 'zwei', key2: 'drei', key3: 'vier' },
      'expected only key0 to change, with key1-key3 preserved from before the sideload'
    )
    assert.equal(
      row!.completeness,
      100,
      'the merged result still covers all 4 base keys, so completeness stays 100'
    )
  })

  test('a partial "en" sideload merges too, and completeness is no longer forced to 100', async () => {
    await fixtures.db.insert(localesTable).values({
      code: 'en',
      name: 'English',
      nativeName: 'English',
      language: 'en',
      region: '',
      script: '',
      isRTL: false,
      strings: { key0: 'value0', key1: 'value1', key2: 'value2', key3: 'value3' },
      completeness: 100
    })

    await writeFile(
      path.join(sideloadDir, 'en.json'),
      JSON.stringify({
        name: 'English',
        language: 'en',
        strings: { key0: 'Page Not Found (customized)' }
      })
    )

    const result = await localesModel.sideloadFromDataPath({ force: true })
    assert.deepEqual(result.loaded, ['en'])

    const [row] = await fixtures.db.select().from(localesTable).where(eq(localesTable.code, 'en'))
    assert.deepEqual(row!.strings, {
      key0: 'Page Not Found (customized)',
      key1: 'value1',
      key2: 'value2',
      key3: 'value3'
    })
    assert.equal(row!.completeness, 100)
  })

  test('a subsequent sideload invalidates the cached getStrings() result for that code', async () => {
    await writeFile(
      path.join(sideloadDir, 'tlh.json'),
      JSON.stringify({ name: 'Klingon', language: 'tlh', strings: { hello: 'nuqneH' } })
    )
    await localesModel.sideloadFromDataPath({ force: true })
    assert.deepEqual(await localesModel.getStrings('tlh'), { hello: 'nuqneH' })

    await writeFile(
      path.join(sideloadDir, 'tlh.json'),
      JSON.stringify({ name: 'Klingon', language: 'tlh', strings: { hello: 'majQa' } })
    )
    await localesModel.sideloadFromDataPath({ force: true })

    assert.deepEqual(
      await localesModel.getStrings('tlh'),
      { hello: 'majQa' },
      'expected the cache to have been invalidated by sideloadFromDataPath(), serving the reloaded strings'
    )
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
    // -> Passes `parseSideloadLocalePack`'s shape check (a string) but overruns `language`'s
    //    `varchar(8)` column, so only the insert can catch it.
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
    const previousDataPath = CARDINAL.config.dataPath
    CARDINAL.config.dataPath = path.join(missingRoot, 'never-created')

    const result = await localesModel.sideloadFromDataPath({ force: true })
    assert.deepEqual(result, { loaded: [], skipped: [] })

    CARDINAL.config.dataPath = previousDataPath
    await rm(missingRoot, { recursive: true, force: true })
  })
})

describe('getLocales() (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let localesModel: typeof import('./locales.ts').locales

  before(async () => {
    fixtures = await setupTestDb()
    ;({ locales: localesModel } = await import('./locales.ts'))
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
  })

  after(async () => {
    await teardownTestDb()
  })

  test('writes only the "locales" cache key, no per-locale entries', async () => {
    const cacheSetCalls = (CARDINAL.cache.set as any).mock.calls.length
    await localesModel.getLocales({ cache: false })

    const newCalls = (CARDINAL.cache.set as any).mock.calls.slice(cacheSetCalls)
    assert.deepEqual(
      newCalls.map((call: any) => call.arguments[0]),
      ['locales']
    )
  })
})

describe('locales.broadcastReload (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let localesModel: typeof import('./locales.ts').locales
  let scratchDir: string
  let sideloadDir: string

  before(async () => {
    await setupTestDb()
    ;({ locales: localesModel } = await import('./locales.ts'))

    scratchDir = await mkdtemp(path.join(tmpdir(), 'wiki-locales-broadcast-test-'))
    await mkdir(path.join(scratchDir, 'server/locales'), { recursive: true })
    await writeFile(
      path.join(scratchDir, 'server/locales/en.json'),
      JSON.stringify({ key0: 'value0' })
    )

    CARDINAL.SERVERPATH = path.join(scratchDir, 'server')
    CARDINAL.ROOTPATH = scratchDir
    CARDINAL.config.dataPath = path.join(scratchDir, 'data')
    sideloadDir = path.join(scratchDir, 'data/locales')
  })

  beforeEach(async () => {
    await rm(sideloadDir, { recursive: true, force: true })
    await mkdir(sideloadDir, { recursive: true })
    ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
  })

  after(async () => {
    await rm(scratchDir, { recursive: true, force: true })
    await teardownTestDb()
  })

  test('sideloadFromDataPath emits exactly one reloadLocales event when it loads a locale', async () => {
    await writeFile(
      path.join(sideloadDir, 'tlh.json'),
      JSON.stringify({ name: 'Klingon', language: 'tlh', strings: { key0: 'wa' } })
    )

    const result = await localesModel.sideloadFromDataPath({ force: true })
    assert.deepEqual(result.loaded, ['tlh'])

    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
    const reloadCalls = calls.filter((c: any) => c.arguments[0] === 'reloadLocales')
    assert.equal(reloadCalls.length, 1, 'expected exactly one reloadLocales broadcast')
  })

  test('sideloadFromDataPath emits nothing when nothing was loaded', async () => {
    const result = await localesModel.sideloadFromDataPath({ force: true })
    assert.deepEqual(result.loaded, [])

    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
    assert.equal(calls.filter((c: any) => c.arguments[0] === 'reloadLocales').length, 0)
  })

  test('subscribeToEvents wires the inbound reloadLocales event to reloadCache, without re-emitting', async () => {
    let reloaded = false
    const originalReloadCache = localesModel.reloadCache.bind(localesModel)
    localesModel.reloadCache = async () => {
      reloaded = true
      await originalReloadCache()
    }
    try {
      localesModel.subscribeToEvents()
      const onCalls = (CARDINAL.events.inbound.on as any).mock.calls
      const handler = onCalls.find((c: any) => c.arguments[0] === 'reloadLocales')?.arguments[1]
      assert.ok(handler, 'expected subscribeToEvents to register a reloadLocales handler')

      await handler()
      assert.equal(reloaded, true)

      const outboundCalls = (CARDINAL.events.outbound.emit as any).mock.calls
      assert.equal(
        outboundCalls.filter((c: any) => c.arguments[0] === 'reloadLocales').length,
        0,
        'the inbound handler must never re-broadcast, or every instance would echo forever'
      )
    } finally {
      localesModel.reloadCache = originalReloadCache
    }
  })

  test('boot-time reloadCache() emits nothing', async () => {
    await localesModel.reloadCache()

    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
    assert.equal(calls.filter((c: any) => c.arguments[0] === 'reloadLocales').length, 0)
  })
})

describe(
  'getStrings() caching and reloadCache() invalidation (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let localesModel: typeof import('./locales.ts').locales

    before(async () => {
      fixtures = await setupTestDb()
      ;({ locales: localesModel } = await import('./locales.ts'))
      await seedLocale(fixtures.db, { code: 'ct' })
      await fixtures.db
        .update(localesTable)
        .set({ strings: { greeting: 'hello' } })
        .where(eq(localesTable.code, 'ct'))
      await seedLocale(fixtures.db, { code: 'ct2' })
      await fixtures.db
        .update(localesTable)
        .set({ strings: { greeting: 'bonjour' } })
        .where(eq(localesTable.code, 'ct2'))
    })

    after(async () => {
      await teardownTestDb()
    })

    test('a second getStrings() call is served from cache rather than a fresh read', async () => {
      const first = await localesModel.getStrings('ct')
      assert.deepEqual(first, { greeting: 'hello' })

      // -> A direct row write bypasses every invalidation path, so a second call still answering the
      //    old value can only be the cache.
      await fixtures.db
        .update(localesTable)
        .set({ strings: { greeting: 'bypassed-the-cache' } })
        .where(eq(localesTable.code, 'ct'))

      const second = await localesModel.getStrings('ct')
      assert.deepEqual(
        second,
        { greeting: 'hello' },
        'expected the stale cached value, not the freshly-written row'
      )
    })

    test('reloadCache() invalidates the cached getStrings() result', async () => {
      // -> A distinct code from the previous test's `ct`, so the priming read below is genuinely
      //    fresh rather than inheriting whatever `ct` left cached.
      const primed = await localesModel.getStrings('ct2')
      assert.deepEqual(primed, { greeting: 'bonjour' })

      await fixtures.db
        .update(localesTable)
        .set({ strings: { greeting: 'reloaded' } })
        .where(eq(localesTable.code, 'ct2'))
      await localesModel.reloadCache()

      assert.deepEqual(await localesModel.getStrings('ct2'), { greeting: 'reloaded' })
    })
  }
)

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
    assert.equal(await localesModel.isReservedLocaleCode('', fixtures.siteId), false)
  })

  describe('with a siteId', () => {
    let originalLocales: any

    beforeEach(() => {
      originalLocales = CARDINAL.sites[fixtures.siteId]!.config.locales
      CARDINAL.sites[fixtures.siteId]!.config.locales = {
        ...originalLocales,
        aliases: { 'pt-BR': 'pt' }
      }
    })

    afterEach(() => {
      CARDINAL.sites[fixtures.siteId]!.config.locales = originalLocales
    })

    test('also reserves a configured alias, case-insensitively', async () => {
      assert.equal(await localesModel.isReservedLocaleCode('pt', fixtures.siteId), true)
      assert.equal(await localesModel.isReservedLocaleCode('PT', fixtures.siteId), true)
    })

    test('does not reserve the alias without the siteId', async () => {
      assert.equal(await localesModel.isReservedLocaleCode('pt'), false)
    })

    test('does not reserve the alias for a site that has not configured it', async () => {
      assert.equal(await localesModel.isReservedLocaleCode('pt', 'no-such-site'), false)
    })

    test('installed codes stay reserved', async () => {
      assert.equal(await localesModel.isReservedLocaleCode('fr', fixtures.siteId), true)
      assert.equal(await localesModel.isReservedLocaleCode('de', fixtures.siteId), false)
    })
  })
})

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
        // -> 'digest' deliberately absent and 'blankKey' present but blank: both per-key fallback
        //    paths, against a locale that IS otherwise installed
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

describe('getStrings() caching (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let localesModel: typeof import('./locales.ts').locales

  before(async () => {
    fixtures = await setupTestDb()
    ;({ locales: localesModel } = await import('./locales.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('a second call for the same code issues no query, reading the cache instead', async () => {
    await seedLocale(fixtures.db, { code: 'ja' })
    await fixtures.db
      .update(localesTable)
      .set({ strings: { hello: 'Konnichiwa' } })
      .where(eq(localesTable.code, 'ja'))

    const first = await localesModel.getStrings('ja')
    assert.deepEqual(first, { hello: 'Konnichiwa' })

    const getCallsBefore = (CARDINAL.cache.get as any).mock.callCount()
    const second = await localesModel.getStrings('ja')

    assert.deepEqual(second, { hello: 'Konnichiwa' })
    assert.equal((CARDINAL.cache.get as any).mock.callCount(), getCallsBefore + 1)
  })

  test('a different code gets its own cache entry', async () => {
    // -> Two non-`en` codes: `en` merges in the bundled `en.json` floor, which a tight `deepEqual`
    //    here would be testing instead of cache namespacing. `nl` rather than `de`, which a later
    //    test in this block seeds for itself.
    await seedLocale(fixtures.db, { code: 'nl' })
    await seedLocale(fixtures.db, { code: 'fr' })
    await fixtures.db
      .update(localesTable)
      .set({ strings: { hello: 'Hallo' } })
      .where(eq(localesTable.code, 'nl'))
    await fixtures.db
      .update(localesTable)
      .set({ strings: { hello: 'Bonjour' } })
      .where(eq(localesTable.code, 'fr'))

    assert.deepEqual(await localesModel.getStrings('nl'), { hello: 'Hallo' })
    assert.deepEqual(await localesModel.getStrings('fr'), { hello: 'Bonjour' })

    assert.equal(CARDINAL.cache.has('localeStrings:nl'), true)
    assert.equal(CARDINAL.cache.has('localeStrings:fr'), true)
  })

  test('reloadCache() drops the per-code key, so a sideloaded pack is visible next call', async () => {
    await seedLocale(fixtures.db, { code: 'de' })
    await fixtures.db
      .update(localesTable)
      .set({ strings: { hello: 'Hallo' } })
      .where(eq(localesTable.code, 'de'))

    await localesModel.getStrings('de')
    assert.equal(CARDINAL.cache.has('localeStrings:de'), true)

    await fixtures.db
      .update(localesTable)
      .set({ strings: { hello: 'Hallo (updated)' } })
      .where(eq(localesTable.code, 'de'))

    await localesModel.reloadCache()
    assert.equal(CARDINAL.cache.has('localeStrings:de'), false)

    assert.deepEqual(await localesModel.getStrings('de'), { hello: 'Hallo (updated)' })
  })

  test('an unknown code caches the empty-array miss too', async () => {
    const result = await localesModel.getStrings('zz-nonexistent')
    assert.deepEqual(result, [])
    assert.equal(CARDINAL.cache.has('localeStrings:zz-nonexistent'), true)
  })

  /**
   * This block leaves `CARDINAL.SERVERPATH` alone, so `getStrings('en')` reads the real
   * `backend/locales/en.json`; `common.actions.apply` is a stable key used as a "some bundled string
   * survived the merge" probe, not as the source of truth for its own value. Order is load-bearing:
   * the no-row case must run before any `en` row is seeded, since `getStrings()` caches per code.
   */
  test('getStrings("en") resolves from the bundled floor alone when no row exists at all', async () => {
    const strings = await localesModel.getStrings('en')
    assert.equal(
      strings['common.actions.apply'],
      'Apply',
      'a fresh install with no en row yet must still resolve real bundled text, not a blank/raw key'
    )
  })

  test('getStrings("en") merges the stored row onto the bundled en.json floor', async () => {
    await seedLocale(fixtures.db, { code: 'en' })
    await fixtures.db
      .update(localesTable)
      .set({ strings: { 'common.actions.apply': 'Commit', hello: 'Custom Hello' } })
      .where(eq(localesTable.code, 'en'))
    // -> The previous test left `localeStrings:en` cached from the no-row case, and this write
    //    bypasses the cache, so the read below would otherwise replay the floor-only value.
    await localesModel.reloadCache()

    const strings = await localesModel.getStrings('en')
    assert.equal(
      strings['common.actions.apply'],
      'Commit',
      'a key present in both the stored row and the bundled file: stored wins'
    )
    assert.equal(strings.hello, 'Custom Hello', 'a key present only in the stored row is kept')
    assert.ok(
      Object.keys(strings).length > 2,
      'expected bundled en.json keys neither override touches to still be present'
    )
  })
})

/**
 * `CARDINAL.SERVERPATH` holds the bundled `en.json`/`de.json`, `CARDINAL.config.dataPath` the
 * operator's sideload directory. Every bundled and sideload file is back-dated a day, so a row
 * written during the test is always fresher than both -- the case where the freshness checks alone
 * would keep a stale or polluted row.
 */
describe(
  'refreshFromDisk() precedence: bundled en, then sideloaded overrides (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let localesModel: typeof import('./locales.ts').locales
    let scratchDir: string
    let sideloadDir: string
    const bundledEn = { key0: 'value0', key1: 'value1', key2: 'value2', key3: 'value3' }
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

    before(async () => {
      fixtures = await setupTestDb()
      ;({ locales: localesModel } = await import('./locales.ts'))
      scratchDir = await mkdtemp(path.join(tmpdir(), 'wiki-locales-precedence-'))
      await mkdir(path.join(scratchDir, 'server/locales'), { recursive: true })
      await writeFile(path.join(scratchDir, 'server/locales/en.json'), JSON.stringify(bundledEn))
      await writeFile(
        path.join(scratchDir, 'server/locales/de.json'),
        JSON.stringify({ key0: 'wert0', key1: 'wert1' })
      )
      for (const file of ['en.json', 'de.json']) {
        await utimes(path.join(scratchDir, 'server/locales', file), dayAgo, dayAgo)
      }
      CARDINAL.SERVERPATH = path.join(scratchDir, 'server')
      CARDINAL.ROOTPATH = scratchDir
      CARDINAL.config.dataPath = path.join(scratchDir, 'data')
      sideloadDir = path.join(scratchDir, 'data/locales')
    })

    beforeEach(async () => {
      await rm(sideloadDir, { recursive: true, force: true })
      await mkdir(sideloadDir, { recursive: true })
      await fixtures.db.delete(localesTable)
      await localesModel.reloadCache()
    })

    after(async () => {
      await rm(scratchDir, { recursive: true, force: true })
      await teardownTestDb()
    })

    async function sideload(code: string, strings: Record<string, string>): Promise<void> {
      const file = path.join(sideloadDir, `${code}.json`)
      await writeFile(file, JSON.stringify({ name: code, language: code, strings }))
      await utimes(file, dayAgo, dayAgo)
    }

    async function storedStrings(code: string) {
      const [row] = await fixtures.db
        .select({ strings: localesTable.strings })
        .from(localesTable)
        .where(eq(localesTable.code, code))
      assert.ok(row, `expected a ${code} row`)
      return row!.strings
    }

    test('an en row fresher than the bundled file, written by something else, is replaced by the bundled strings', async () => {
      await seedLocale(fixtures.db, { code: 'en' })
      await fixtures.db
        .update(localesTable)
        .set({ strings: { key0: 'Wiki.js version', upstreamOnly: 'x' }, updatedAt: sql`now()` })
        .where(eq(localesTable.code, 'en'))

      await localesModel.refreshFromDisk()

      assert.deepEqual(await storedStrings('en'), bundledEn)
      assert.equal(((await localesModel.getStrings('en')) as any).key0, 'value0')
    })

    test("an operator's en sideload override survives that replacement", async () => {
      await seedLocale(fixtures.db, { code: 'en' })
      await fixtures.db
        .update(localesTable)
        .set({ strings: { ...bundledEn, key1: 'polluted' }, updatedAt: sql`now()` })
        .where(eq(localesTable.code, 'en'))
      await sideload('en', { key1: 'customized' })

      await localesModel.refreshFromDisk()

      assert.deepEqual(await storedStrings('en'), { ...bundledEn, key1: 'customized' })
    })

    test('a bundled locale written from disk keeps a sideloaded override on top', async () => {
      await sideload('de', { key0: 'EINS (customized)' })

      await localesModel.refreshFromDisk()

      assert.deepEqual(await storedStrings('de'), { key0: 'EINS (customized)', key1: 'wert1' })
    })
  }
)
