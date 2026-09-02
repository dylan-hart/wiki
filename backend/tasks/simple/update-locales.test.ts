import { after, before, beforeEach, describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { locales as localesTable } from '../../db/schema.ts'
import { isFlatStringMap, task } from './update-locales.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * `isFlatStringMap` is the shape guard OpenProject #2255 added: `strings` comes straight off
 * `raw.githubusercontent.com` with no signature, so it is the one thing standing between a
 * compromised `requarks/wiki-locales` and arbitrary values landing in the `locales.strings` jsonb
 * column. Pure function, no `WIKI`/database needed. The task-level wiring around it (percent-encoded
 * URLs, invalid payloads never reaching the insert, a valid payload upserting) is already covered by
 * the "update-locales.task (unit, no DB)" suite below, so this suite sticks to the predicate itself.
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

  test('every fetch carries an abort signal (OpenProject #2253)', async () => {
    stubFetch([makeLang('de-t4', 'German')], { 'de-t4': { welcome: 'Willkommen' } })

    await task()

    const calls = (globalThis.fetch as unknown as ReturnType<typeof mock.fn>).mock.calls
    assert.ok(calls.length >= 2, 'expected at least the metadata fetch + one per-language fetch')
    for (const call of calls) {
      const init = call.arguments[1] as RequestInit | undefined
      assert.ok(init?.signal instanceof AbortSignal, 'fetch call missing an AbortSignal')
    }
  })

  test('a non-ok metadata response aborts the run before any per-language fetch is issued (OpenProject #2253)', async () => {
    globalThis.fetch = mock.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('metadata.json')) {
        return new Response('Service Unavailable', { status: 503 })
      }
      throw new Error(`unexpected per-language fetch for ${url}`)
    }) as unknown as typeof fetch

    await assert.rejects(task(), /503/)

    const calls = (globalThis.fetch as unknown as ReturnType<typeof mock.fn>).mock.calls
    assert.equal(calls.length, 1, 'expected only the metadata fetch to have been issued')
  })

  // -------------------------------------------------------------------------------------------
  // Cache reload (OpenProject #2032) -- `getLocales()` (`models/locales.ts`) serves the `'locales'`
  // cache key whenever it is populated, so a locale synced by this task is invisible to
  // `GET /_api/locales` (and `api/sites.ts`'s `installedCodes` validation) until the cache is
  // reloaded. Reloading is gated on `anyUpdated` so a no-op nightly run does no cache churn.
  // `broadcastReload()` (which `task()` actually calls) reaches `reloadCache()` internally, so
  // mocking `reloadCache` here still observes it firing.
  // -------------------------------------------------------------------------------------------

  test('reloads the locale cache exactly once when it upserted at least one row', async (t) => {
    stubFetch([makeLang('de-t4', 'German')], { 'de-t4': { welcome: 'Willkommen' } })
    const reloadCache = t.mock.method(WIKI.models.locales, 'reloadCache')

    await task()

    assert.equal(reloadCache.mock.callCount(), 1)
  })

  test('does not reload the locale cache when nothing changed', async (t) => {
    stubFetch([makeLang('it-t5', 'Italian')], {}) // -> no strings file, so nothing upserts
    const reloadCache = t.mock.method(WIKI.models.locales, 'reloadCache')

    await task()

    assert.equal(reloadCache.mock.callCount(), 0)
  })
})

/**
 * OpenProject #2253/#2255: the fetch/validation hardening around this task — abort timeouts, the
 * missing `ok` check, percent-encoding the derived filename, and rejecting a non-flat `strings`
 * payload before it ever reaches the database. Unlike the suite above, none of this needs a real
 * Postgres instance: `WIKI.db.insert` is stubbed directly (the same manual-stub approach
 * `check-version.test.ts` uses), so this runs unconditionally rather than being gated on
 * `DATABASE_URL`.
 */
describe('update-locales.task (unit, no DB)', () => {
  let wikiHandle: { restore(): void }
  let previousFetch: typeof fetch
  let insertValues: ReturnType<typeof mock.fn>
  let onConflictDoUpdate: ReturnType<typeof mock.fn>
  let loggerWarn: ReturnType<typeof mock.fn>
  let broadcastReload: ReturnType<typeof mock.fn>

  before(() => {
    previousFetch = globalThis.fetch
  })

  after(() => {
    wikiHandle.restore()
    globalThis.fetch = previousFetch
  })

  beforeEach(() => {
    onConflictDoUpdate = mock.fn(async () => true)
    insertValues = mock.fn(() => ({ onConflictDoUpdate }))
    loggerWarn = mock.fn()
    broadcastReload = mock.fn(async () => {})
    wikiHandle = installTestWiki({
      config: {},
      logger: { info: mock.fn(), error: mock.fn(), warn: loggerWarn, debug: mock.fn() },
      db: { insert: () => ({ values: insertValues }) },
      // -> `task()` calls `WIKI.models.locales.broadcastReload()` once `anyUpdated` (OpenProject
      //    #2032) -- stubbed the same way `models.locales.reloadCache` is elsewhere in this file.
      //    Deliberately no `reloadCache` method here (OpenProject #2352): if `task()` ever called
      //    `WIKI.models.locales.reloadCache()` directly instead of routing through the HA
      //    cache-broadcast path, that call would throw rather than silently succeed.
      models: { locales: { broadcastReload } }
    })
  })

  function makeLang(overrides: Record<string, any> = {}) {
    return {
      language: 'fr',
      region: '',
      script: '',
      name: 'French',
      localizedName: 'French',
      isRtl: false,
      ...overrides
    }
  }

  test('every fetch carries an AbortSignal', async () => {
    const calls: Array<[string, any]> = []
    globalThis.fetch = mock.fn(async (url: string, opts?: any) => {
      calls.push([url, opts])
      if (url.includes('metadata.json')) {
        return new Response(JSON.stringify({ languages: [makeLang()] }), { status: 200 })
      }
      return new Response(JSON.stringify({ welcome: 'Bienvenue' }), { status: 200 })
    }) as unknown as typeof fetch

    await task()

    assert.equal(calls.length, 2)
    for (const [, opts] of calls) {
      assert.ok(opts?.signal instanceof AbortSignal, 'fetch call is missing an AbortSignal')
    }
  })

  test('a non-ok metadata response aborts the run before any per-language fetch', async () => {
    const fetchSpy = mock.fn(async (url: string) => {
      if (url.includes('metadata.json')) {
        return new Response('Internal Server Error', { status: 500 })
      }
      throw new Error('per-language fetch should never be reached')
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await assert.rejects(task())

    assert.equal(fetchSpy.mock.callCount(), 1)
    assert.equal(insertValues.mock.callCount(), 0)
  })

  test('percent-encodes the derived filename in the strings URL', async () => {
    // -> A region containing path-traversal-shaped characters proves the filename segment is
    //    encoded rather than concatenated raw into the URL path.
    const calls: string[] = []
    globalThis.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      if (url.includes('metadata.json')) {
        return new Response(JSON.stringify({ languages: [makeLang({ region: '../../evil' })] }), {
          status: 200
        })
      }
      return new Response(JSON.stringify({ welcome: 'Bienvenue' }), { status: 200 })
    }) as unknown as typeof fetch

    await task()

    const stringsUrl = calls.find((u) => !u.includes('metadata.json'))
    assert.ok(stringsUrl, 'strings URL was never fetched')
    assert.equal(stringsUrl!.includes('../../evil'), false)
    assert.equal(stringsUrl!.includes(encodeURIComponent('fr-../../evil')), true)
  })

  test('rejects a strings payload that is not a flat string map before inserting', async () => {
    globalThis.fetch = mock.fn(async (url: string) => {
      if (url.includes('metadata.json')) {
        return new Response(JSON.stringify({ languages: [makeLang()] }), { status: 200 })
      }
      return new Response(JSON.stringify({ nested: { not: 'flat' } }), { status: 200 })
    }) as unknown as typeof fetch

    await assert.doesNotReject(task())

    assert.equal(insertValues.mock.callCount(), 0)
    assert.equal(loggerWarn.mock.callCount(), 1)
    assert.equal(
      broadcastReload.mock.callCount(),
      0,
      'a rejected, non-inserted payload should not trigger a cache broadcast'
    )
  })

  test('accepts a genuinely flat string map', async () => {
    globalThis.fetch = mock.fn(async (url: string) => {
      if (url.includes('metadata.json')) {
        return new Response(JSON.stringify({ languages: [makeLang()] }), { status: 200 })
      }
      return new Response(JSON.stringify({ welcome: 'Bienvenue' }), { status: 200 })
    }) as unknown as typeof fetch

    await task()

    assert.equal(insertValues.mock.callCount(), 1)
    assert.equal(onConflictDoUpdate.mock.callCount(), 1)
  })

  // -----------------------------------------------------------------------------------------
  // OpenProject #2352: `task()` must route a real update through
  // `WIKI.models.locales.broadcastReload()` -- which reloads this instance's own cache AND
  // notifies every other cluster instance to do the same -- rather than a plain, local-only
  // `reloadCache()` call. The mock WIKI above has no `reloadCache` method at all, so a
  // regression here would surface as `task()` throwing, but these assertions prove the correct
  // *positive* behavior directly rather than relying on that absence alone.
  // -----------------------------------------------------------------------------------------

  test('routes a real update through the HA cache-broadcast path exactly once', async () => {
    globalThis.fetch = mock.fn(async (url: string) => {
      if (url.includes('metadata.json')) {
        return new Response(JSON.stringify({ languages: [makeLang()] }), { status: 200 })
      }
      return new Response(JSON.stringify({ welcome: 'Bienvenue' }), { status: 200 })
    }) as unknown as typeof fetch

    await task()

    assert.equal(broadcastReload.mock.callCount(), 1)
  })

  test('does not broadcast a cache reload when no strings file was found', async () => {
    globalThis.fetch = mock.fn(async (url: string) => {
      if (url.includes('metadata.json')) {
        return new Response(JSON.stringify({ languages: [makeLang()] }), { status: 200 })
      }
      return new Response('Not Found', { status: 404 })
    }) as unknown as typeof fetch

    await task()

    assert.equal(insertValues.mock.callCount(), 0)
    assert.equal(broadcastReload.mock.callCount(), 0)
  })
})
