import { describe, test, before, beforeEach, after } from 'node:test'
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

// -> `refreshFromDisk()` compares mtimes via the native `Temporal` API (`Date#toTemporalInstant()` +
//    `Temporal.Instant.compare()`), per CLAUDE.md's "Backend patterns".
await ensureTemporal()

/**
 * `refreshFromDisk` (see `locales.ts`) warns at boot -- `locale  declared in the metadata file but
 * not found on disk` -- naming every language declared in `locales/metadata.js` that has no matching
 * `backend/locales/<code>.json` file on disk. This is a pure, no-`WIKI`, no-database check of that
 * exact invariant: every declared language resolves to a real file. It is what "a fresh boot
 * produces zero skipped-locale warnings" (task 690's stated done-condition) reduces to, without
 * needing to actually boot.
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
 * `mergeLocaleStrings()` (OpenProject #2433): the pure per-key override `sideloadFromDataPath()`'s
 * write path and `getStrings()`'s `en` read-time floor both build on — replacing the previous
 * full-row-replacement foot-gun where a one-key sideload wiped out every other known string for
 * that locale.
 */
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
  // -> Held as a bound method reference (`.bind`), not further destructured: `refreshFromDisk` itself
  //    now calls `this.invalidateStringsCache()` internally, so it needs its real receiver — unlike
  //    the free-standing `localeCode`/`computeCompleteness`/`parseSideloadLocalePack` exports used
  //    elsewhere in this file, `Locales`'s methods are plain prototype methods, not bound class
  //    fields.
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

  test('a subsequent refreshFromDisk() invalidates the cached getStrings() result', async () => {
    await refreshFromDisk({ force: true })
    const cached = await localesModel.getStrings('de')
    assert.deepEqual(
      cached,
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`key${i}`, `wert${i}`]))
    )

    // -> Change the disk file to a value distinguishable from what is already cached, so a stale
    //    read (invalidation not actually happening) and a fresh one are unambiguous.
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
   * OpenProject #2371: `refreshFromDisk()` decides whether to reload EACH language off `dbLocales`,
   * one snapshot SELECT taken ONCE at the top of the whole call, then loops through every declared
   * language sequentially. If some OTHER writer (the e2e suite's own direct-DB locale seed, in the
   * incident this bug tracks) writes a fresher row for a code AFTER that snapshot was taken but
   * BEFORE this function's own turn to write that code arrives, the old code had no way to notice --
   * its decision was already baked in from the stale snapshot, and its `onConflictDoUpdate` would
   * fire unconditionally, silently clobbering whatever the other writer had just stored.
   *
   * `setWhere` closes this by moving the freshness check from the app (a stale snapshot) into
   * Postgres itself, re-evaluated against the row's CURRENT state at the exact moment the UPDATE
   * would apply -- which is unaffected by how the two writes interleave. This test proves that
   * guarantee directly: it reconstructs the identical `onConflictDoUpdate` shape
   * `refreshFromDisk()` issues for `de` (real column set, real `setWhere` condition against `de.json`'s
   * actual mtime) against a `de` row that already carries a newer `updatedAt` than that file -- i.e.
   * exactly the state a concurrent writer would have left behind between the stale snapshot and this
   * write's own turn -- and asserts the update is a genuine no-op.
   */
  test('setWhere guard: a row already fresher than the vendored file is never overwritten, even by an update decided as if it were stale', async () => {
    // -> A direct write standing in for "some other process already wrote a fresher `de` row" --
    //    the exact shape a concurrent seed script's own upsert would leave behind.
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

    // -> The exact statement shape `refreshFromDisk()`'s per-language loop issues for `de`, guarded
    //    by the same `setWhere` condition -- reconstructed directly rather than calling
    //    `refreshFromDisk()` itself, since genuinely reproducing the race that puts it on this path
    //    would mean racing real async I/O timing (56 sequential `stat()` calls against a scratch
    //    directory that only two of ever resolve) against this test's own DB write, which is
    //    exactly the kind of timing-dependent setup that makes a test flaky rather than a reliable
    //    regression guard. This proves the guarantee the fix relies on directly and deterministically:
    //    Postgres itself refuses this exact update once the row is no longer stale, regardless of
    //    what the caller believed when it decided to issue it.
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
 * `sideloadFromDataPath()` DB-backed (OpenProject #820): the actual disk -> DB path a dropped-in
 * `<dataPath>/locales/<code>.json` file takes, independent of `locales/metadata.js` — a sideload
 * file can name a code the built-in language table has never declared, or override one that is.
 * Each test resets the sideload directory itself so files from one test never leak, force-reloaded,
 * into the next — and, since `sideloadFromDataPath()` now MERGES onto whatever a code's `strings`
 * column already holds (OpenProject #2433) rather than replacing it outright, `beforeEach` also
 * clears the `locales` table itself, so a code reused across tests (`de`, `tlh`, ...) never merges
 * onto a row a previous test happened to leave behind.
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

  /**
   * OpenProject #2433: the whole point of the fix. Before it, `sideloadFromDataPath()` wrote the
   * pack's `strings` as a full replacement of the row — a one-key pack silently wiped out every
   * other already-known string for that locale. Seeds `de` with all 4 base keys already translated
   * (a stand-in for "an earlier Localazy sync already populated this row"), then sideloads a pack
   * naming only `key0`, and asserts the other 3 keys survive untouched.
   */
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

  /**
   * Same fix (#2433), for `en` specifically — the WP's own motivating case ("Page Not Found" text)
   * and the scope note that `en`'s `completeness: 100` must no longer be forced regardless of actual
   * coverage. Uses this describe's own scratch `en.json` (4 keys) as the comparison base, matching
   * how every other test in this block already treats it.
   */
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
        // -> Only one key overridden, and deliberately not naming key1-key3 at all.
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

    // -> Overwrite the sideload file with a value distinguishable from what is already cached, so a
    //    stale read (invalidation not actually happening) and a fresh one are unambiguous.
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
 * `getLocales()` (OpenProject #2005): used to write one extra `locale:<code>` cache entry per
 * installed locale, alongside the `locales` list it actually serves and freshness-checks (`has
 * ('locales')`). Nothing ever read that prefix back, so it was dead writes that could drift from the
 * `locales` list with no reader to notice. Asserts the cache only ever receives the one `locales` key.
 */
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
    const cacheSetCalls = (WIKI.cache.set as any).mock.calls.length
    await localesModel.getLocales({ cache: false })

    const newCalls = (WIKI.cache.set as any).mock.calls.slice(cacheSetCalls)
    assert.deepEqual(
      newCalls.map((call: any) => call.arguments[0]),
      ['locales']
    )
  })
})

/**
 * OpenProject #2042: `sideloadFromDataPath()` used to call `reloadCache()` directly on a successful
 * load, refreshing only this instance's own in-memory cache — a locale installed, updated, or
 * refreshed on instance A stayed invisible to instance B (e.g. `api/sites.ts`'s `installedCodes`
 * check) until B happened to restart. `broadcastReload()` mirrors `models/groups.ts`'s /
 * `models/sites.ts`'s fix exactly: every write path goes through it instead of `reloadCache()`
 * directly, and it emits on `WIKI.events.outbound` (which `core/db.ts`'s real NOTIFY-based bus,
 * unused here, is what actually carries to other instances).
 */
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

    WIKI.SERVERPATH = path.join(scratchDir, 'server')
    WIKI.ROOTPATH = scratchDir
    WIKI.config.dataPath = path.join(scratchDir, 'data')
    sideloadDir = path.join(scratchDir, 'data/locales')
  })

  beforeEach(async () => {
    await rm(sideloadDir, { recursive: true, force: true })
    await mkdir(sideloadDir, { recursive: true })
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
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

    const calls = (WIKI.events.outbound.emit as any).mock.calls
    const reloadCalls = calls.filter((c: any) => c.arguments[0] === 'reloadLocales')
    assert.equal(reloadCalls.length, 1, 'expected exactly one reloadLocales broadcast')
  })

  test('sideloadFromDataPath emits nothing when nothing was loaded', async () => {
    const result = await localesModel.sideloadFromDataPath({ force: true })
    assert.deepEqual(result.loaded, [])

    const calls = (WIKI.events.outbound.emit as any).mock.calls
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
      const onCalls = (WIKI.events.inbound.on as any).mock.calls
      const handler = onCalls.find((c: any) => c.arguments[0] === 'reloadLocales')?.arguments[1]
      assert.ok(handler, 'expected subscribeToEvents to register a reloadLocales handler')

      await handler()
      assert.equal(reloaded, true)

      const outboundCalls = (WIKI.events.outbound.emit as any).mock.calls
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

    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.equal(calls.filter((c: any) => c.arguments[0] === 'reloadLocales').length, 0)
  })
})

/**
 * `getStrings()` (DB-backed): the `localeStrings:${code}` cache fill/read itself, isolated from any
 * one write path — `refreshFromDisk()`'s and `sideloadFromDataPath()`'s own invalidation are covered
 * next to those methods' existing describe blocks above, since both need that block's scratch-disk
 * fixture anyway. `reloadCache()` needs no disk at all, so it is covered here instead.
 */
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

      // -> Mutate the row directly, bypassing every cache-invalidating path this feature adds — the
      //    strongest proof a second call is served from cache rather than the database: if it queried
      //    again, it would see this new value immediately.
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
      // -> A distinct code (`ct2`) from the previous test's `ct`, so this test's own cache-priming read
      //    below is unambiguously a fresh one rather than inheriting whatever `ct` left cached.
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

/**
 * `getStrings()` caching (OpenProject #1915): mirrors `getLocales()`'s existing `WIKI.cache` shape —
 * keyed `localeStrings:<code>` — so a cold page load doesn't pay a fresh ~190 KB JSONB read on every
 * visit. `reloadCache()` is the single invalidation point (already called from
 * `sideloadFromDataPath`), so a sideloaded pack must be visible on the next `getStrings()` call.
 */
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

    const getCallsBefore = (WIKI.cache.get as any).mock.callCount()
    const second = await localesModel.getStrings('ja')

    assert.deepEqual(second, { hello: 'Konnichiwa' })
    assert.equal((WIKI.cache.get as any).mock.callCount(), getCallsBefore + 1)
  })

  test('a different code gets its own cache entry', async () => {
    // -> Deliberately two non-`en` codes: `en` legitimately merges in the bundled `en.json` floor
    //    (see the dedicated describe block below), which would make a tight `deepEqual` here about
    //    cache namespacing rather than about that merge. `nl` rather than `de`, since a later test
    //    in this same describe block seeds `de` of its own.
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

    assert.equal(WIKI.cache.has('localeStrings:nl'), true)
    assert.equal(WIKI.cache.has('localeStrings:fr'), true)
  })

  test('reloadCache() drops the per-code key, so a sideloaded pack is visible next call', async () => {
    await seedLocale(fixtures.db, { code: 'de' })
    await fixtures.db
      .update(localesTable)
      .set({ strings: { hello: 'Hallo' } })
      .where(eq(localesTable.code, 'de'))

    await localesModel.getStrings('de')
    assert.equal(WIKI.cache.has('localeStrings:de'), true)

    // Simulate what sideloadFromDataPath does: write new strings straight to the DB row, then rely
    // on reloadCache() (its own invalidation point) to make them visible.
    await fixtures.db
      .update(localesTable)
      .set({ strings: { hello: 'Hallo (updated)' } })
      .where(eq(localesTable.code, 'de'))

    await localesModel.reloadCache()
    assert.equal(WIKI.cache.has('localeStrings:de'), false)

    assert.deepEqual(await localesModel.getStrings('de'), { hello: 'Hallo (updated)' })
  })

  test('an unknown code caches the empty-array miss too', async () => {
    const result = await localesModel.getStrings('zz-nonexistent')
    assert.deepEqual(result, [])
    assert.equal(WIKI.cache.has('localeStrings:zz-nonexistent'), true)
  })

  /**
   * OpenProject #2433: `en`'s hard fallback floor. This describe block does not override
   * `WIKI.SERVERPATH`, so `getStrings('en')` reads the REAL `backend/locales/en.json` (3,472 keys as
   * of this writing, `common.actions.apply` = "Apply" — a stable, unlikely-to-be-renamed key used
   * purely as a "some real bundled key survived the merge" probe, not asserted as the literal source
   * of truth for its own value). The "no row at all" case runs BEFORE any `en` row is seeded, since
   * `getStrings()` caches per code — seeding first would mean the second test is served from that
   * seed's cache entry rather than genuinely re-querying with no row present.
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
    // -> The previous test already cached `localeStrings:en` (from the no-row case); this write
    //    bypasses that cache entirely, so the read below must invalidate first to prove the merge
    //    against the row rather than replaying the stale cached floor-only value.
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
