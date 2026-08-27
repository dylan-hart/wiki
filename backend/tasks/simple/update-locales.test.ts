import { after, before, beforeEach, describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { locales as localesTable } from '../../db/schema.ts'
import { isFlatStringMap } from './update-locales.ts'

/**
 * `isFlatStringMap` is the shape guard OpenProject #2255 added: `strings` comes straight off
 * `raw.githubusercontent.com` with no signature, so it is the one thing standing between a
 * compromised `requarks/wiki-locales` and arbitrary values landing in the `locales.strings` jsonb
 * column. Pure function, no `WIKI`/database needed.
 */
describe('update-locales.isFlatStringMap', () => {
  test('accepts a flat string -> string map', () => {
    assert.equal(isFlatStringMap({ welcome: 'Bienvenue', bye: 'Au revoir' }), true)
  })

  test('accepts an empty object', () => {
    assert.equal(isFlatStringMap({}), true)
  })

  test('rejects null', () => {
    assert.equal(isFlatStringMap(null), false)
  })

  test('rejects an array', () => {
    assert.equal(isFlatStringMap(['Bienvenue']), false)
  })

  test('rejects a nested object value', () => {
    assert.equal(isFlatStringMap({ welcome: { nested: 'Bienvenue' } }), false)
  })

  test('rejects a non-string value', () => {
    assert.equal(isFlatStringMap({ welcome: 42 }), false)
  })

  test('rejects a primitive', () => {
    assert.equal(isFlatStringMap('Bienvenue'), false)
  })
})

/**
 * Pure-unit coverage of `task()`'s own fetch/validate wiring, with `WIKI.db` stubbed rather than a
 * real Postgres connection -- fast enough to run on every change, unlike the DB-backed suite below.
 * Covers the two OpenProject #2255 behaviors that don't need a real row round-trip: the strings URL
 * percent-encodes the derived filename, and an invalid `strings` payload never reaches the insert.
 */
describe('update-locales.task (pure unit, WIKI.db stubbed)', () => {
  let task: typeof import('./update-locales.ts').task
  let originalFetch: typeof fetch
  let originalWiki: WikiGlobal

  before(async () => {
    ;({ task } = await import('./update-locales.ts'))
    originalFetch = globalThis.fetch
    originalWiki = globalThis.WIKI
  })

  after(() => {
    globalThis.fetch = originalFetch
    globalThis.WIKI = originalWiki
  })

  /** Builds a single-language metadata payload for a given language/strings pair. */
  function makeLang(language: string, name: string, overrides: Partial<any> = {}) {
    return {
      language,
      region: '',
      script: '',
      name,
      localizedName: name,
      isRtl: false,
      ...overrides
    }
  }

  /** A `WIKI.db.insert(...).values(...).onConflictDoUpdate(...)` stub recording every `values()` call. */
  function createInsertStub() {
    const valuesCalls: any[] = []
    const db = {
      insert: mock.fn(() => ({
        values: mock.fn((values: any) => {
          valuesCalls.push(values)
          return { onConflictDoUpdate: mock.fn(async () => {}) }
        })
      }))
    }
    return { db, valuesCalls }
  }

  beforeEach(() => {
    globalThis.WIKI = {
      config: {},
      logger: { info: mock.fn(), debug: mock.fn(), warn: mock.fn(), error: mock.fn() }
    } as unknown as WikiGlobal
  })

  /** Stubs `fetch` to serve `metadataLangs` from the metadata endpoint and a fixed `strings` payload
   *  from every per-language endpoint, recording each fetched URL. */
  function stubFetch(metadataLangs: ReturnType<typeof makeLang>[], strings: unknown): string[] {
    const urls: string[] = []
    globalThis.fetch = mock.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('metadata.json')) {
        return new Response(JSON.stringify({ languages: metadataLangs }), { status: 200 })
      }
      return new Response(JSON.stringify(strings), { status: 200 })
    }) as unknown as typeof fetch
    return urls
  }

  test('percent-encodes the derived filename in the strings URL', async () => {
    const { db } = createInsertStub()
    WIKI.db = db as any
    const urls = stubFetch([makeLang('fr', 'French', { region: 'CA fake', script: '' })], {
      welcome: 'Bienvenue'
    })

    await task()

    const stringsUrl = urls.find((u) => !u.includes('metadata.json'))
    assert.ok(stringsUrl, 'expected a per-language strings fetch')
    assert.ok(
      stringsUrl!.endsWith(`${encodeURIComponent('fr-CA fake')}.json`),
      `expected the URL to percent-encode the derived filename, got: ${stringsUrl}`
    )
    assert.ok(!stringsUrl!.includes(' '), 'expected no literal space in the URL')
  })

  test('rejects a strings payload that is not a flat string map, before inserting', async () => {
    const { db, valuesCalls } = createInsertStub()
    WIKI.db = db as any
    stubFetch([makeLang('fr', 'French')], { welcome: { nested: 'Bienvenue' } })

    await assert.doesNotReject(task())

    assert.equal(valuesCalls.length, 0)
    assert.equal((WIKI.logger.warn as any).mock.callCount(), 1)
  })

  test('rejects an array strings payload, before inserting', async () => {
    const { db, valuesCalls } = createInsertStub()
    WIKI.db = db as any
    stubFetch([makeLang('fr', 'French')], ['Bienvenue'])

    await assert.doesNotReject(task())

    assert.equal(valuesCalls.length, 0)
  })

  test('inserts a valid flat string map', async () => {
    const { db, valuesCalls } = createInsertStub()
    WIKI.db = db as any
    stubFetch([makeLang('fr', 'French')], { welcome: 'Bienvenue' })

    await task()

    assert.equal(valuesCalls.length, 1)
    assert.deepEqual(valuesCalls[0].strings, { welcome: 'Bienvenue' })
  })
})

/**
 * `task()` is the daily `updateLocales` scheduled job: it pulls the language list + each language's
 * strings from `requarks/wiki-locales` on GitHub and upserts them into the `locales` table, mirroring
 * the `insert(...).onConflictDoUpdate(...)` pattern `models/locales.ts#refreshFromDisk` uses for the
 * on-disk sync path. This is a DB-backed suite (a real row round-tripping through Postgres) with the
 * network calls stubbed, since the whole point under test is the fetch → upsert wiring, not GitHub.
 */
describe('update-locales.task (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let task: typeof import('./update-locales.ts').task
  let originalFetch: typeof fetch

  before(async () => {
    fixtures = await setupTestDb()
    ;({ task } = await import('./update-locales.ts'))
    originalFetch = globalThis.fetch
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await teardownTestDb()
  })

  beforeEach(() => {
    WIKI.config = {}
  })

  /** Builds a single-language metadata payload for a given language/strings pair. */
  function makeLang(language: string, name: string, isRtl = false) {
    return { language, region: '', script: '', name, localizedName: name, isRtl }
  }

  /**
   * Stubs `fetch` to serve `metadataLangs` from the metadata endpoint and `stringsByLang` (keyed by
   * language code) from the per-language endpoint. A language absent from `stringsByLang` gets a 404,
   * exercising the "no strings file yet" branch.
   */
  function stubFetch(
    metadataLangs: ReturnType<typeof makeLang>[],
    stringsByLang: Record<string, any>
  ): void {
    globalThis.fetch = mock.fn(async (url: string) => {
      if (url.includes('metadata.json')) {
        return new Response(JSON.stringify({ languages: metadataLangs }), { status: 200 })
      }
      const match = /locales\/([\w-]+)\.json$/.exec(url)
      const lang = match?.[1]
      const strings = lang ? stringsByLang[lang] : undefined
      if (!strings) {
        return new Response('Not Found', { status: 404 })
      }
      return new Response(JSON.stringify(strings), { status: 200 })
    }) as unknown as typeof fetch
  }

  test('fetches metadata + per-language strings and upserts each locale row', async () => {
    stubFetch([makeLang('fr-t1', 'French'), makeLang('ar-t1', 'Arabic', true)], {
      'fr-t1': { welcome: 'Bienvenue' },
      'ar-t1': { welcome: 'أهلا وسهلا' }
    })

    await task()

    const rows = await fixtures.db
      .select()
      .from(localesTable)
      .where(eq(localesTable.language, 'fr-t1'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.code, 'fr-t1')
    assert.equal(rows[0]!.name, 'French')
    assert.equal(rows[0]!.nativeName, 'French')
    assert.equal(rows[0]!.isRTL, false)
    assert.deepEqual(rows[0]!.strings, { welcome: 'Bienvenue' })

    const arRows = await fixtures.db
      .select()
      .from(localesTable)
      .where(eq(localesTable.language, 'ar-t1'))
    assert.equal(arRows.length, 1)
    assert.equal(arRows[0]!.isRTL, true)
    assert.deepEqual(arRows[0]!.strings, { welcome: 'أهلا وسهلا' })
  })

  test('re-running upserts (updates) rather than duplicating the row', async () => {
    stubFetch([makeLang('fr-t2', 'French')], { 'fr-t2': { welcome: 'Bienvenue' } })
    await task()

    stubFetch([makeLang('fr-t2', 'French')], { 'fr-t2': { welcome: 'Bienvenue!' } })
    await task()

    const rows = await fixtures.db
      .select()
      .from(localesTable)
      .where(eq(localesTable.language, 'fr-t2'))
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0]!.strings, { welcome: 'Bienvenue!' })
  })

  test('skips a language with no strings file on wiki-locales without throwing', async () => {
    stubFetch([makeLang('es-t3', 'Spanish')], {})

    await assert.doesNotReject(task())

    const rows = await fixtures.db
      .select()
      .from(localesTable)
      .where(eq(localesTable.language, 'es-t3'))
    assert.equal(rows.length, 0)
  })

  test('does nothing when update.locales is explicitly disabled', async () => {
    WIKI.config = { update: { locales: false } }
    const fetchSpy = mock.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await task()

    assert.equal(fetchSpy.mock.callCount(), 0)
  })

  test('does nothing when the instance is in offline mode (OpenProject #820)', async () => {
    WIKI.config = { offline: true }
    const fetchSpy = mock.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await assert.doesNotReject(task())

    assert.equal(fetchSpy.mock.callCount(), 0)
  })
})
