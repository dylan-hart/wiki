import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { search } from './search.ts'
import type {
  RebuildResult,
  SearchEngineDefinition,
  SearchIndexablePage,
  SearchModule,
  SearchPagesParams,
  SearchPagesResult
} from './search.ts'

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A fixture page, cast through `unknown` rather than filled field-for-field: the point of this suite
 * is that `SearchModule`'s hooks compose with the page row and with the reused `SearchPagesResult` /
 * `RebuildResult` shapes, not to re-describe every `pages` column (already covered by `db/schema.ts`
 * and `models/pages.test.ts`).
 */
function fakePage(overrides: Partial<{ id: string; siteId: string; path: string }> = {}) {
  return {
    id: 'page-1',
    siteId: 'site-1',
    path: 'getting-started',
    locale: 'en',
    title: 'Getting Started',
    ...overrides
  } as unknown as SearchIndexablePage
}

/**
 * A minimal in-memory `SearchModule`, exercised the way `models/search.ts`'s future `ensureModule()`
 * (task #558) will call a real one: every hook mandatory, `query`/`rebuild` returning the exact shapes
 * `models/search.ts` already produces today, so a caller written against the Postgres `db` provider
 * needs no special-casing for a second engine.
 */
function makeFakeSearchModule(): { calls: string[]; module: SearchModule } {
  const calls: string[] = []
  const module: SearchModule = {
    async init(siteId, config) {
      calls.push(`init:${siteId}:${JSON.stringify(config)}`)
    },
    async created(page) {
      calls.push(`created:${page.id}`)
    },
    async updated(page) {
      calls.push(`updated:${page.id}`)
    },
    async deleted(siteId, pageId) {
      calls.push(`deleted:${siteId}:${pageId}`)
    },
    async renamed(siteId, page, previousPath) {
      calls.push(`renamed:${siteId}:${page.id}:${previousPath}`)
    },
    async query(params: SearchPagesParams): Promise<SearchPagesResult> {
      calls.push(`query:${params.siteId}:${params.query ?? ''}`)
      return { results: [], totalHits: 0 }
    },
    async rebuild(siteId: string): Promise<RebuildResult> {
      calls.push(`rebuild:${siteId}`)
      return { pages: 0, locales: [] }
    }
  }
  return { calls, module }
}

describe('SearchModule interface', () => {
  test('every hook is callable and its return shape matches the reused Search* types', async () => {
    const { calls, module } = makeFakeSearchModule()
    const page = fakePage({ id: 'page-1', siteId: 'site-1' })

    await module.init('site-1', { apiKey: 'secret' })
    await module.created(page)
    await module.updated(page)
    await module.deleted('site-1', 'page-2')
    await module.renamed('site-1', page, 'old-path')
    const queryResult = await module.query({ siteId: 'site-1', query: 'wiki' })
    const rebuildResult = await module.rebuild('site-1')

    assert.deepEqual(calls, [
      'init:site-1:{"apiKey":"secret"}',
      'created:page-1',
      'updated:page-1',
      'deleted:site-1:page-2',
      'renamed:site-1:page-1:old-path',
      'query:site-1:wiki',
      'rebuild:site-1'
    ])
    assert.deepEqual(queryResult, { results: [], totalHits: 0 })
    assert.deepEqual(rebuildResult, { pages: 0, locales: [] })
  })
})

describe('SearchEngineDefinition', () => {
  test('carries a props map of ModuleProp, same as StorageDefinition / AuthModule', () => {
    const definition: SearchEngineDefinition = {
      key: 'db',
      title: 'Database',
      description: 'PostgreSQL full-text search.',
      vendor: 'Wiki.js',
      website: 'https://js.wiki',
      props: {
        termHighlighting: {
          default: false,
          type: 'boolean',
          title: 'Term Highlighting',
          hint: '',
          enum: false,
          enumDisplay: 'select',
          multiline: false,
          sensitive: false,
          readOnly: false,
          icon: 'text-box-search',
          order: 100,
          if: []
        }
      }
    }

    assert.equal(definition.key, 'db')
    assert.equal(definition.props.termHighlighting.type, 'boolean')
    // -> dictOverrides is a locale -> dictionary map, not representable by ModuleProp, so it is
    //    deliberately absent from props (see the comment on SearchEngineDefinition in search.ts).
    assert.equal((definition.props as Record<string, unknown>).dictOverrides, undefined)
  })
})

/**
 * `search.refreshFromDisk()` / `hasImplementation()` / `getDefinition()`, task #558.
 *
 * Reads the same way `Storage.refreshFromDisk()` does (`models/storage.ts`): `WIKI.SERVERPATH` points
 * at a throwaway fixture directory rather than the real repo, so this covers the scanning/sorting/prop
 * -normalization logic without depending on what actually ships under `modules/search/*` today.
 */
describe('search.refreshFromDisk() / hasImplementation() / getDefinition()', () => {
  let dir: string
  let previousWiki: any

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wikijs-search-model-test-'))

    await mkdir(path.join(dir, 'modules/search/db'), { recursive: true })
    await writeFile(
      path.join(dir, 'modules/search/db/definition.yml'),
      [
        'title: Database',
        'description: PostgreSQL full-text search.',
        'vendor: Wiki.js',
        'website: https://js.wiki',
        'props:',
        '  termHighlighting:',
        '    type: Boolean',
        '    title: Term Highlighting',
        '    order: 100'
      ].join('\n')
    )

    // -> Sorted after `db` alphabetically by title, and the only one of the two with an implementation
    await mkdir(path.join(dir, 'modules/search/zzz-engine'), { recursive: true })
    await writeFile(
      path.join(dir, 'modules/search/zzz-engine/definition.yml'),
      [
        'title: ZZZ Engine',
        'description: A fake engine, sorted after db.',
        'vendor: Test',
        'website: https://example.com',
        'props: {}'
      ].join('\n')
    )
    await writeFile(path.join(dir, 'modules/search/zzz-engine/search.ts'), 'export default {}\n')

    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = {
      SERVERPATH: dir,
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    }
  })

  after(async () => {
    ;(globalThis as any).WIKI = previousWiki
    await rm(dir, { recursive: true, force: true })
  })

  test('reads every modules/search/*/definition.yml, keying each by its directory name', async () => {
    await search.refreshFromDisk()
    assert.deepEqual(
      search.definitions.map((d) => d.key),
      ['db', 'zzz-engine']
    )
  })

  test('sorts the db module first regardless of title, ahead of alphabetical order', async () => {
    await search.refreshFromDisk()
    assert.equal(search.definitions[0]!.key, 'db')
  })

  test('normalizes props through parseModuleProps', async () => {
    await search.refreshFromDisk()
    const db = search.getDefinition('db')!
    assert.equal(db.props.termHighlighting!.type, 'boolean')
    assert.equal(db.props.termHighlighting!.default, false)
  })

  test('getDefinition() returns null for a key nothing on disk declares', async () => {
    await search.refreshFromDisk()
    assert.equal(search.getDefinition('nonexistent'), null)
  })

  test('hasImplementation() is true only for a module with a sibling search.ts', async () => {
    assert.equal(await search.hasImplementation('db'), false)
    assert.equal(await search.hasImplementation('zzz-engine'), true)
  })
})

/**
 * `search.ensureModule()`, task #558.
 *
 * Unlike `refreshFromDisk()`/`hasImplementation()`, the dynamic import inside `ensureModule()` is a
 * fixed relative specifier (`../modules/search/${key}/search.ts`, resolved from `models/search.ts`'s
 * own location) rather than something built off `WIKI.SERVERPATH` — that's exactly what makes it the
 * "extension-sensitive dynamic path" CLAUDE.md tracks. So this writes real, throwaway fixture modules
 * under the actual `backend/modules/search/` directory (cleaned up in `after`) instead of a tmp dir,
 * and points `WIKI.SERVERPATH` at the real backend root so `hasImplementation()`'s gate agrees with it.
 */
describe('search.ensureModule()', () => {
  const fixtureKey = '__test-fixture-ensure-module'
  const throwingKey = '__test-fixture-ensure-module-throws'
  const fixtureDir = path.join(backendDir, 'modules/search', fixtureKey)
  const throwingDir = path.join(backendDir, 'modules/search', throwingKey)
  let previousWiki: any

  before(async () => {
    await mkdir(fixtureDir, { recursive: true })
    await writeFile(
      path.join(fixtureDir, 'search.ts'),
      'export default { marker: "fixture-module" }\n'
    )
    await mkdir(throwingDir, { recursive: true })
    await writeFile(path.join(throwingDir, 'search.ts'), 'throw new Error("boom")\n')

    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = {
      SERVERPATH: backendDir,
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    }
  })

  after(async () => {
    ;(globalThis as any).WIKI = previousWiki
    await rm(fixtureDir, { recursive: true, force: true })
    await rm(throwingDir, { recursive: true, force: true })
  })

  test('dynamic-imports ../modules/search/<key>/search.ts and returns its default export', async () => {
    const mod = await search.ensureModule(fixtureKey)
    assert.deepEqual(mod, { marker: 'fixture-module' })
  })

  test('caches the loaded module by key: a second call returns the exact same object', async () => {
    const first = await search.ensureModule(fixtureKey)
    const second = await search.ensureModule(fixtureKey)
    assert.equal(first, second)
  })

  test('returns null, without throwing, for a key with no sibling search.ts', async () => {
    assert.equal(await search.ensureModule('__test-fixture-ensure-module-nonexistent'), null)
  })

  test('returns null, without throwing, when the module throws while loading', async () => {
    assert.equal(await search.ensureModule(throwingKey), null)
  })
})

/**
 * `search.getConfig(siteId)`, task #563: `termHighlighting`/`dictOverrides` moved from the
 * instance-wide `WIKI.config.search` to the per-site `WIKI.sites[siteId].config.search.config`, a
 * sibling of `search.engine` seeded by `models/sites.ts`'s per-site defaults.
 */
describe('search.getConfig()', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = {
      sites: {},
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    }
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('reads termHighlighting/dictOverrides off the named site, not off any other site', () => {
    ;(globalThis as any).WIKI.sites['site-a'] = {
      id: 'site-a',
      config: {
        search: {
          engine: 'db',
          config: { termHighlighting: true, dictOverrides: { en: 'english' } }
        }
      }
    }
    ;(globalThis as any).WIKI.sites['site-b'] = {
      id: 'site-b',
      config: { search: { engine: 'db', config: { termHighlighting: false, dictOverrides: {} } } }
    }

    assert.deepEqual(search.getConfig('site-a'), {
      termHighlighting: true,
      dictOverrides: { en: 'english' }
    })
    assert.deepEqual(search.getConfig('site-b'), {
      termHighlighting: false,
      dictOverrides: {}
    })
  })

  test('defaults to termHighlighting: false and an empty dictOverrides for a site with no search config', () => {
    ;(globalThis as any).WIKI.sites['site-bare'] = { id: 'site-bare', config: {} }

    assert.deepEqual(search.getConfig('site-bare'), {
      termHighlighting: false,
      dictOverrides: {}
    })
  })

  test('defaults the same way for a siteId nothing in WIKI.sites knows about', () => {
    assert.deepEqual(search.getConfig('site-nonexistent'), {
      termHighlighting: false,
      dictOverrides: {}
    })
  })
})

/**
 * `search.query()` / `.rebuild()` / `.created()` / `.updated()` / `.deleted()` / `.renamed()`, task
 * #561: the dispatcher resolves `WIKI.sites[siteId]?.config?.search?.engine` (falling back to `db`)
 * and delegates to whatever `SearchModule` that key loads.
 *
 * Modules are injected straight into `search.modules` rather than through real fixture directories:
 * `ensureModule()` already checks that cache before touching disk (see the `describe` above), so
 * seeding it here exercises exactly the dispatcher's resolution logic — reading `WIKI.sites`, falling
 * back to `db`, forwarding every argument — without needing a `db/search.ts` capable of running real
 * SQL against a `WIKI.db` this suite has none of.
 */
describe('search dispatcher (query/rebuild/created/updated/deleted/renamed)', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = {
      sites: {},
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    }
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('a site with no configured engine dispatches to the db module', async () => {
    const { calls, module: dbModule } = makeFakeSearchModule()
    search.modules.db = dbModule
    ;(globalThis as any).WIKI.sites['site-default'] = { id: 'site-default', config: {} }

    const result = await search.query({ siteId: 'site-default', query: 'wiki' })

    assert.deepEqual(calls, ['query:site-default:wiki'])
    assert.deepEqual(result, { results: [], totalHits: 0 })
  })

  test('a site with a configured engine dispatches to that engine instead of db', async () => {
    const { calls: dbCalls, module: dbModule } = makeFakeSearchModule()
    const { calls: customCalls, module: customModule } = makeFakeSearchModule()
    search.modules.db = dbModule
    search.modules['custom-engine'] = customModule
    ;(globalThis as any).WIKI.sites['site-custom'] = {
      id: 'site-custom',
      config: { search: { engine: 'custom-engine' } }
    }

    await search.rebuild('site-custom')

    assert.deepEqual(customCalls, ['rebuild:site-custom'])
    assert.deepEqual(dbCalls, [])
  })

  test('created()/updated() resolve the engine from the page’s own siteId', async () => {
    const { calls, module: dbModule } = makeFakeSearchModule()
    search.modules.db = dbModule
    const page = fakePage({ id: 'page-9', siteId: 'site-default' })

    await search.created(page)
    await search.updated(page)

    assert.deepEqual(calls, ['created:page-9', 'updated:page-9'])
  })

  test('deleted() forwards siteId and pageId to the resolved engine', async () => {
    const { calls, module: dbModule } = makeFakeSearchModule()
    search.modules.db = dbModule

    await search.deleted('site-default', 'page-gone')

    assert.deepEqual(calls, ['deleted:site-default:page-gone'])
  })

  test('renamed() forwards siteId, the page and the previous path to the resolved engine', async () => {
    const { calls, module: dbModule } = makeFakeSearchModule()
    search.modules.db = dbModule
    const page = fakePage({ id: 'page-moved', siteId: 'site-default' })

    await search.renamed('site-default', page, 'old/path')

    assert.deepEqual(calls, ['renamed:site-default:page-moved:old/path'])
  })
})
