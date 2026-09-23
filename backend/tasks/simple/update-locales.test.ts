import { after, before, beforeEach, describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { locales as localesTable } from '../../db/schema.ts'
import { isFlatStringMap, task } from './update-locales.ts'
import { installTestWiki } from '../../test/mocks.ts'

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

describe('update-locales.task (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let task: typeof import('./update-locales.ts').task
  let originalFetch: typeof fetch
  let scratchDir: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ task } = await import('./update-locales.ts'))
    originalFetch = globalThis.fetch

    scratchDir = await mkdtemp(path.join(tmpdir(), 'update-locales-test-'))
    await mkdir(path.join(scratchDir, 'locales'), { recursive: true })
    await writeFile(
      path.join(scratchDir, 'locales/en.json'),
      JSON.stringify({ welcome: 'Welcome', bye: 'Goodbye', save: 'Save', cancel: 'Cancel' })
    )
    CARDINAL.SERVERPATH = scratchDir
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await rm(scratchDir, { recursive: true, force: true })
    await teardownTestDb()
  })

  beforeEach(() => {
    CARDINAL.config = {}
  })

  function makeLang(language: string, name: string, isRtl = false) {
    return { language, region: '', script: '', name, localizedName: name, isRtl }
  }

  /** A language absent from `stringsByLang` answers 404 — the "no strings file yet" branch. */
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

  async function seedLocale(code: string, strings: unknown, completeness = 0): Promise<void> {
    await fixtures.db.insert(localesTable).values({
      code,
      name: code,
      nativeName: code,
      language: code,
      region: '',
      script: '',
      isRTL: false,
      strings: strings as Record<string, unknown>,
      completeness
    })
  }

  async function storedRow(code: string) {
    const [row] = await fixtures.db
      .select({ strings: localesTable.strings, completeness: localesTable.completeness })
      .from(localesTable)
      .where(eq(localesTable.code, code))
    assert.ok(row, `expected a ${code} row`)
    return row!
  }

  test('keeps stored strings the download does not contain, e.g. sideloaded or Cardinal-only keys', async () => {
    await seedLocale('fr-t6', {
      welcome: 'Bienvenue (ancien)',
      save: 'Enregistrer (sideloaded)',
      'cardinal.only': 'Seulement Cardinal'
    })
    stubFetch([makeLang('fr-t6', 'French')], {
      'fr-t6': { welcome: 'Bienvenue', bye: 'Au revoir' }
    })

    await task()

    const row = await storedRow('fr-t6')
    assert.deepEqual(row.strings, {
      welcome: 'Bienvenue',
      bye: 'Au revoir',
      save: 'Enregistrer (sideloaded)',
      'cardinal.only': 'Seulement Cardinal'
    })
  })

  test('computes completeness off the merged strings against the bundled en strings', async () => {
    await seedLocale('fr-t7', { save: 'Enregistrer', cancel: 'Annuler' }, 0)
    stubFetch([makeLang('fr-t7', 'French')], { 'fr-t7': { welcome: 'Bienvenue' } })

    await task()

    assert.equal((await storedRow('fr-t7')).completeness, 75)
  })

  test('computes completeness for a brand-new locale row', async () => {
    stubFetch([makeLang('fr-t8', 'French')], { 'fr-t8': { welcome: 'Bienvenue', bye: '' } })

    await task()

    assert.equal((await storedRow('fr-t8')).completeness, 25)
  })

  test('merges onto a row still holding the column default as if it were empty', async () => {
    await seedLocale('fr-t9', [])
    stubFetch([makeLang('fr-t9', 'French')], { 'fr-t9': { welcome: 'Bienvenue' } })

    await task()

    const row = await storedRow('fr-t9')
    assert.deepEqual(row.strings, { welcome: 'Bienvenue' })
    assert.equal(row.completeness, 25)
  })

  test('invalidates the cached getStrings() result for a merged locale', async () => {
    await seedLocale('fr-t10', { welcome: 'Bienvenue (ancien)', save: 'Enregistrer' })
    assert.deepEqual(await CARDINAL.models.locales.getStrings('fr-t10'), {
      welcome: 'Bienvenue (ancien)',
      save: 'Enregistrer'
    })
    stubFetch([makeLang('fr-t10', 'French')], { 'fr-t10': { welcome: 'Bienvenue' } })

    await task()

    assert.deepEqual(await CARDINAL.models.locales.getStrings('fr-t10'), {
      welcome: 'Bienvenue',
      save: 'Enregistrer'
    })
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
    CARDINAL.config = { update: { locales: false } }
    const fetchSpy = mock.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await task()

    assert.equal(fetchSpy.mock.callCount(), 0)
  })

  test('does nothing when the instance is in offline mode (OpenProject #820)', async () => {
    CARDINAL.config = { offline: true }
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

  // -> `task()` calls `broadcastReload()`, which reaches `reloadCache()` internally, so mocking
  //    `reloadCache` still observes the reload firing.

  test('reloads the locale cache exactly once when it upserted at least one row', async (t) => {
    stubFetch([makeLang('de-t4', 'German')], { 'de-t4': { welcome: 'Willkommen' } })
    const reloadCache = t.mock.method(CARDINAL.models.locales, 'reloadCache')

    await task()

    assert.equal(reloadCache.mock.callCount(), 1)
  })

  test('does not reload the locale cache when nothing changed', async (t) => {
    stubFetch([makeLang('it-t5', 'Italian')], {}) // -> no strings file, so nothing upserts
    const reloadCache = t.mock.method(CARDINAL.models.locales, 'reloadCache')

    await task()

    assert.equal(reloadCache.mock.callCount(), 0)
  })
})

describe('update-locales.task (unit, no DB)', () => {
  let wikiHandle: { restore(): void }
  let previousFetch: typeof fetch
  let mergeDownloadedStrings: ReturnType<typeof mock.fn>
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
    mergeDownloadedStrings = mock.fn(async () => 100)
    loggerWarn = mock.fn()
    broadcastReload = mock.fn(async () => {})
    wikiHandle = installTestWiki({
      config: {},
      logger: { info: mock.fn(), error: mock.fn(), warn: loggerWarn, debug: mock.fn() },
      // -> Deliberately no `reloadCache` method: a `task()` that reloaded locally instead of
      //    broadcasting to the cluster would throw here rather than silently pass.
      models: { locales: { broadcastReload, mergeDownloadedStrings } }
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
    assert.equal(mergeDownloadedStrings.mock.callCount(), 0)
  })

  test('percent-encodes the derived filename in the strings URL', async () => {
    // -> The path-traversal-shaped region is what proves the filename segment is encoded rather
    //    than concatenated raw into the URL path.
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

    assert.equal(mergeDownloadedStrings.mock.callCount(), 0)
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

    assert.equal(mergeDownloadedStrings.mock.callCount(), 1)
  })

  test('hands the downloaded strings, the language metadata and the bundled en strings to mergeDownloadedStrings', async () => {
    globalThis.fetch = mock.fn(async (url: string) => {
      if (url.includes('metadata.json')) {
        return new Response(
          JSON.stringify({ languages: [makeLang({ region: 'CA', isRtl: false })] }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ welcome: 'Bienvenue' }), { status: 200 })
    }) as unknown as typeof fetch

    await task()

    assert.equal(mergeDownloadedStrings.mock.callCount(), 1)
    const [code, meta, downloaded, baseStrings] = mergeDownloadedStrings.mock.calls[0]!
      .arguments as [
      string,
      Record<string, unknown>,
      Record<string, string>,
      Record<string, unknown>
    ]
    assert.equal(code, 'fr-CA')
    assert.deepEqual(meta, {
      name: 'French',
      nativeName: 'French',
      language: 'fr',
      region: 'CA',
      script: '',
      isRTL: false
    })
    assert.deepEqual(downloaded, { welcome: 'Bienvenue' })
    assert.equal(typeof baseStrings['common.actions.save'], 'string')
  })

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

    assert.equal(mergeDownloadedStrings.mock.callCount(), 0)
    assert.equal(broadcastReload.mock.callCount(), 0)
  })
})
