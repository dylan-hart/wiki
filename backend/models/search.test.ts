import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import type { ModuleProp } from '../helpers/moduleProps.ts'

/** A prop shaped the way `parseModuleProps` (helpers/moduleProps.ts) normalizes a `definition.yml` entry. */
function fakeProp(overrides: Partial<ModuleProp> = {}): ModuleProp {
  return {
    default: false,
    type: 'boolean',
    title: 'Term Highlighting',
    hint: '',
    enum: false,
    enumDisplay: 'select',
    multiline: false,
    sensitive: false,
    readOnly: false,
    required: false,
    pattern: '',
    icon: 'text-box-search',
    order: 100,
    if: [],
    ...overrides
  }
}

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
    async renamed(siteId, page, previousPath, previousLocale) {
      calls.push(`renamed:${siteId}:${page.id}:${previousLocale}/${previousPath}`)
    },
    async query(params: SearchPagesParams): Promise<SearchPagesResult> {
      calls.push(`query:${params.siteId}:${params.query ?? ''}`)
      return { results: [], totalHits: 0, totalHitsApproximate: false, suggestion: null }
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
    await module.renamed('site-1', page, 'old-path', 'de')
    const queryResult = await module.query({ siteId: 'site-1', query: 'wiki' })
    const rebuildResult = await module.rebuild('site-1')

    assert.deepEqual(calls, [
      'init:site-1:{"apiKey":"secret"}',
      'created:page-1',
      'updated:page-1',
      'deleted:site-1:page-2',
      'renamed:site-1:page-1:de/old-path',
      'query:site-1:wiki',
      'rebuild:site-1'
    ])
    assert.deepEqual(queryResult, {
      results: [],
      totalHits: 0,
      totalHitsApproximate: false,
      suggestion: null
    })
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
          required: false,
          pattern: '',
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
 * `search.getConfig(siteId)`, task #563: `dictOverrides` moved from the instance-wide
 * `WIKI.config.search` to the per-site `WIKI.sites[siteId].config.search.config`, a sibling of
 * `search.engine` seeded by `models/sites.ts`'s per-site defaults. `termHighlighting` used to live
 * here too, until task #574 moved it into the `db` engine's own per-engine config -- see
 * `search.getEngineConfig()` below.
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

  test('reads dictOverrides off the named site, not off any other site', () => {
    ;(globalThis as any).WIKI.sites['site-a'] = {
      id: 'site-a',
      config: {
        search: {
          engine: 'db',
          config: { dictOverrides: { en: 'english' } }
        }
      }
    }
    ;(globalThis as any).WIKI.sites['site-b'] = {
      id: 'site-b',
      config: { search: { engine: 'db', config: { dictOverrides: {} } } }
    }

    assert.deepEqual(search.getConfig('site-a'), {
      dictOverrides: { en: 'english' }
    })
    assert.deepEqual(search.getConfig('site-b'), {
      dictOverrides: {}
    })
  })

  test('defaults to an empty dictOverrides for a site with no search config', () => {
    ;(globalThis as any).WIKI.sites['site-bare'] = { id: 'site-bare', config: {} }

    assert.deepEqual(search.getConfig('site-bare'), {
      dictOverrides: {}
    })
  })

  test('defaults the same way for a siteId nothing in WIKI.sites knows about', () => {
    assert.deepEqual(search.getConfig('site-nonexistent'), {
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
    assert.deepEqual(result, {
      results: [],
      totalHits: 0,
      totalHitsApproximate: false,
      suggestion: null
    })
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

  test('renamed() forwards siteId, the page and where it moved from to the resolved engine', async () => {
    const { calls, module: dbModule } = makeFakeSearchModule()
    search.modules.db = dbModule
    const page = fakePage({ id: 'page-moved', siteId: 'site-default' })

    // -> Both halves of where it was: a move can change the locale as well as the path
    await search.renamed('site-default', page, 'old/path', 'de')

    assert.deepEqual(calls, ['renamed:site-default:page-moved:de/old/path'])
  })

  /**
   * Engine resolution itself is private to the dispatcher (`getActiveEngine`), so its two failure
   * branches are exercised through `query()` -- the same way every real caller reaches them.
   */
  test('falls back to db when the configured engine has no loaded implementation', async () => {
    const { calls, module: dbModule } = makeFakeSearchModule()
    search.modules.db = dbModule
    delete search.modules['missing-engine']
    ;(globalThis as any).WIKI.sites['site-missing'] = {
      id: 'site-missing',
      config: { search: { engine: 'missing-engine' } }
    }

    await search.query({ siteId: 'site-missing', query: 'wiki' })

    assert.deepEqual(calls, ['query:site-missing:wiki'])
  })

  test('throws when neither the configured engine nor db has a loaded implementation', async () => {
    delete search.modules.db
    delete search.modules['missing-engine']
    ;(globalThis as any).WIKI.sites['site-none'] = {
      id: 'site-none',
      config: { search: { engine: 'missing-engine' } }
    }

    await assert.rejects(
      () => search.query({ siteId: 'site-none', query: 'wiki' }),
      /No search engine implementation is available/
    )
  })
})

/**
 * `search.getSiteEngines()` / `.buildEngineConfig()` / `.validateEngineConfig()` / `.selectEngine()`,
 * task #570: the site-scoped engine picker built on top of `refreshFromDisk()`'s definitions.
 */
describe('search engine picker (getSiteEngines/buildEngineConfig/validateEngineConfig/selectEngine)', () => {
  let previousWiki: any
  let previousDefinitions: SearchEngineDefinition[]

  const dbDefinition: SearchEngineDefinition = {
    key: 'db',
    title: 'Database',
    description: 'PostgreSQL full-text search.',
    vendor: 'Wiki.js',
    website: 'https://js.wiki',
    props: {
      termHighlighting: fakeProp()
    }
  }
  const customDefinition: SearchEngineDefinition = {
    key: 'custom-engine',
    title: 'Custom Engine',
    description: 'A fake external engine.',
    vendor: 'Test',
    website: 'https://example.com',
    props: {
      apiKey: fakeProp({
        default: '',
        type: 'string',
        title: 'API Key',
        sensitive: true,
        icon: 'key'
      }),
      mode: fakeProp({
        default: 'fast',
        type: 'string',
        title: 'Mode',
        enum: ['fast|Fast', 'accurate|Accurate'],
        icon: 'tune'
      })
    }
  }

  /**
   * A third, distinct fixture (task #556): a required prop left empty must be refused, and a
   * shaped prop must match its declared `pattern` -- neither `dbDefinition` nor `customDefinition`
   * declares either, so a dedicated engine keeps those two fixtures' existing tests undisturbed.
   */
  const strictDefinition: SearchEngineDefinition = {
    key: 'strict-engine',
    title: 'Strict Engine',
    description: 'A fake external engine with a required field and a shaped field.',
    vendor: 'Test',
    website: 'https://example.com',
    props: {
      apiKey: fakeProp({
        default: '',
        type: 'string',
        title: 'API Key',
        required: true,
        icon: 'key'
      }),
      hosts: fakeProp({
        default: '',
        type: 'string',
        title: 'Host(s)',
        pattern: '^https?://[\\w.-]+(:\\d+)?$',
        icon: 'server'
      })
    }
  }

  before(() => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = {
      sites: {},
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    }
    previousDefinitions = search.definitions
    search.definitions = [dbDefinition, customDefinition, strictDefinition]
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
    search.definitions = previousDefinitions
  })

  describe('getSiteEngines()', () => {
    test('lists every definition, marking the site’s configured engine as selected', async () => {
      ;(globalThis as any).WIKI.sites['site-a'] = {
        id: 'site-a',
        config: { search: { engine: 'custom-engine', engines: {} } }
      }

      const engines = await search.getSiteEngines('site-a')

      assert.deepEqual(
        engines.map((e) => e.key),
        ['db', 'custom-engine', 'strict-engine']
      )
      assert.equal(engines.find((e) => e.key === 'db')!.isSelected, false)
      assert.equal(engines.find((e) => e.key === 'custom-engine')!.isSelected, true)
    })

    test('defaults to the db engine selected for a site with no engine configured', async () => {
      ;(globalThis as any).WIKI.sites['site-bare'] = { id: 'site-bare', config: {} }

      const engines = await search.getSiteEngines('site-bare')

      assert.equal(engines.find((e) => e.key === 'db')!.isSelected, true)
    })

    test('hasImplementation reflects whether a search.ts sits next to the definition', async () => {
      ;(globalThis as any).WIKI.sites['site-bare'] = { id: 'site-bare', config: {} }

      const engines = await search.getSiteEngines('site-bare')

      // -> Neither fixture definition has a sibling search.ts under the real modules/search tree
      assert.equal(engines.find((e) => e.key === 'db')!.hasImplementation, false)
      assert.equal(engines.find((e) => e.key === 'custom-engine')!.hasImplementation, false)
    })

    test('completes stored config with the engine defaults for a prop never saved', async () => {
      ;(globalThis as any).WIKI.sites['site-c'] = {
        id: 'site-c',
        config: {
          search: {
            engine: 'custom-engine',
            engines: { 'custom-engine': { apiKey: 'secret-key' } }
          }
        }
      }

      const engines = await search.getSiteEngines('site-c')
      const custom = engines.find((e) => e.key === 'custom-engine')!

      assert.deepEqual(custom.config, { apiKey: 'secret-key', mode: 'fast' })
    })

    test('keeps a non-selected engine’s stored config rather than dropping it', async () => {
      ;(globalThis as any).WIKI.sites['site-d'] = {
        id: 'site-d',
        config: {
          search: {
            engine: 'db',
            engines: { 'custom-engine': { apiKey: 'still-here', mode: 'accurate' } }
          }
        }
      }

      const engines = await search.getSiteEngines('site-d')
      const custom = engines.find((e) => e.key === 'custom-engine')!

      assert.equal(custom.isSelected, false)
      assert.deepEqual(custom.config, { apiKey: 'still-here', mode: 'accurate' })
    })

    test('a sensitive prop (apiKey) never leaves a masked read, and default (unmasked) stays real', async () => {
      ;(globalThis as any).WIKI.sites['site-e'] = {
        id: 'site-e',
        config: {
          search: {
            engine: 'custom-engine',
            engines: { 'custom-engine': { apiKey: 'super-secret-key', mode: 'accurate' } }
          }
        }
      }

      // -> Default: `selectEngine()`/`initActiveEngines()` never call this at all, but any future
      //    caller besides the admin list route must still get the real value by default.
      const unmasked = await search.getSiteEngines('site-e')
      assert.equal(
        unmasked.find((e) => e.key === 'custom-engine')!.config.apiKey,
        'super-secret-key'
      )

      // -> `{ mask: true }`: what the admin GET routes (api/search.ts) actually return.
      const masked = await search.getSiteEngines('site-e', { mask: true })
      const custom = masked.find((e) => e.key === 'custom-engine')!
      assert.equal(custom.config.apiKey, '********')
      // -> A non-sensitive prop on the same engine is untouched by masking.
      assert.equal(custom.config.mode, 'accurate')
    })
  })

  describe('getEngineConfig()', () => {
    test('reads one engine’s stored config for a site, completed with defaults', () => {
      ;(globalThis as any).WIKI.sites['site-f'] = {
        id: 'site-f',
        config: {
          search: {
            engine: 'db',
            engines: { db: { termHighlighting: true } }
          }
        }
      }

      assert.deepEqual(search.getEngineConfig('site-f', 'db'), { termHighlighting: true })
    })

    test('falls back to the engine’s declared defaults for a site with nothing stored for it', () => {
      ;(globalThis as any).WIKI.sites['site-g'] = { id: 'site-g', config: {} }

      assert.deepEqual(search.getEngineConfig('site-g', 'db'), { termHighlighting: false })
    })
  })

  describe('buildEngineConfig()', () => {
    test('fills every declared prop from incoming, falling back to existing, falling back to default', () => {
      const config = search.buildEngineConfig(
        'custom-engine',
        { apiKey: 'new-key' },
        { apiKey: 'old-key', mode: 'accurate' }
      )
      assert.deepEqual(config, { apiKey: 'new-key', mode: 'accurate' })
    })

    test('drops a key the engine does not declare', () => {
      const config = search.buildEngineConfig('custom-engine', { nonsense: true })
      assert.deepEqual(config, { apiKey: '', mode: 'fast' })
    })

    test('returns an empty object for an unknown engine key', () => {
      assert.deepEqual(search.buildEngineConfig('nonexistent', { anything: 1 }), {})
    })

    test('drops a sensitive value that is just the mask echoed back, keeping the real existing one', () => {
      const config = search.buildEngineConfig(
        'custom-engine',
        { apiKey: '********', mode: 'accurate' },
        { apiKey: 'real-existing-secret', mode: 'fast' }
      )
      assert.deepEqual(config, { apiKey: 'real-existing-secret', mode: 'accurate' })
    })

    test('accepts a genuinely new sensitive value that happens not to be the mask', () => {
      const config = search.buildEngineConfig(
        'custom-engine',
        { apiKey: 'brand-new-secret' },
        { apiKey: 'old-secret' }
      )
      assert.deepEqual(config, { apiKey: 'brand-new-secret', mode: 'fast' })
    })
  })

  describe('validateEngineConfig()', () => {
    test('accepts a config with only declared keys of the right type', () => {
      assert.equal(
        search.validateEngineConfig('custom-engine', { apiKey: 'abc', mode: 'fast' }),
        null
      )
    })

    test('rejects an unrecognized prop, naming the engine', () => {
      const message = search.validateEngineConfig('custom-engine', { bogus: 'x' })
      assert.match(message!, /"bogus"/)
      assert.match(message!, /Custom Engine/)
    })

    test('rejects a value not in the declared enum', () => {
      const message = search.validateEngineConfig('custom-engine', { mode: 'ludicrous' })
      assert.match(message!, /not a valid value for Mode/)
    })

    test('rejects a wrong-typed string prop', () => {
      const message = search.validateEngineConfig('custom-engine', { apiKey: 42 })
      assert.match(message!, /API Key must be a string/)
    })

    test('rejects a wrong-typed boolean prop', () => {
      const message = search.validateEngineConfig('db', { termHighlighting: 'yes' })
      assert.match(message!, /Term Highlighting must be true or false/)
    })

    test('rejects a required prop left empty, naming the engine', () => {
      const message = search.validateEngineConfig('strict-engine', { hosts: 'http://x:1' })
      assert.match(message!, /API Key is required/)
      assert.match(message!, /Strict Engine/)
    })

    test('accepts a required prop that was already stored, without it being resent', () => {
      assert.equal(
        search.validateEngineConfig(
          'strict-engine',
          { hosts: 'http://x:1' },
          { apiKey: 'stored-key' }
        ),
        null
      )
    })

    test('rejects a value that fails the declared pattern', () => {
      const message = search.validateEngineConfig('strict-engine', {
        apiKey: 'k',
        hosts: 'not-a-url'
      })
      assert.match(message!, /Host\(s\) is not valid for Strict Engine/)
    })

    test('accepts a value that matches the declared pattern', () => {
      assert.equal(
        search.validateEngineConfig('strict-engine', { apiKey: 'k', hosts: 'http://x:1' }),
        null
      )
    })

    test('does not flag a required prop that is merely absent from the effective config’s defaults when it has no default and nothing stored', () => {
      // -> Same case as the first test above, restated: `hosts` has no `required: true`, so an
      //    empty default is fine for it even though it also has a `pattern` -- patterns are only
      //    checked once a value is non-empty.
      assert.equal(search.validateEngineConfig('strict-engine', { apiKey: 'k' }), null)
    })
  })

  describe('selectEngine()', () => {
    test('writes engine + built config through WIKI.models.sites.updateSite', async () => {
      const calls: any[] = []
      ;(globalThis as any).WIKI.sites['site-e'] = {
        id: 'site-e',
        config: { search: { engine: 'db', engines: {} } }
      }
      ;(globalThis as any).WIKI.models = {
        sites: {
          updateSite: async (siteId: string, patch: any) => {
            calls.push([siteId, patch])
            return true
          }
        }
      }

      const result = await search.selectEngine('site-e', 'custom-engine', { apiKey: 'k' })

      assert.equal(result, true)
      assert.deepEqual(calls, [
        [
          'site-e',
          {
            config: {
              search: {
                engine: 'custom-engine',
                engines: { 'custom-engine': { apiKey: 'k', mode: 'fast' } }
              }
            }
          }
        ]
      ])
    })

    test('starts from the engine’s previously-stored config when incoming omits a prop', async () => {
      ;(globalThis as any).WIKI.sites['site-f'] = {
        id: 'site-f',
        config: {
          search: {
            engine: 'db',
            engines: { 'custom-engine': { apiKey: 'kept-key', mode: 'accurate' } }
          }
        }
      }
      let written: any
      ;(globalThis as any).WIKI.models = {
        sites: {
          updateSite: async (_siteId: string, patch: any) => {
            written = patch
            return true
          }
        }
      }

      await search.selectEngine('site-f', 'custom-engine', { mode: 'fast' })

      assert.deepEqual(written.config.search.engines['custom-engine'], {
        apiKey: 'kept-key',
        mode: 'fast'
      })
    })

    /**
     * OpenProject #920: selecting an engine never provisioned it -- nothing called `init()`. Fixed by
     * having `selectEngine()` call the resolved module's `init()` itself, once the site write succeeds.
     */
    test('calls the newly selected engine’s init() with the config that was just built and stored', async () => {
      const { calls: initCalls, module: fakeModule } = makeFakeSearchModule()
      search.modules['custom-engine'] = fakeModule
      ;(globalThis as any).WIKI.sites['site-h'] = {
        id: 'site-h',
        config: { search: { engine: 'db', engines: {} } }
      }
      ;(globalThis as any).WIKI.models = {
        sites: { updateSite: async () => true }
      }

      try {
        await search.selectEngine('site-h', 'custom-engine', { apiKey: 'k' })
        assert.deepEqual(initCalls, [
          `init:site-h:${JSON.stringify({ apiKey: 'k', mode: 'fast' })}`
        ])
      } finally {
        delete search.modules['custom-engine']
      }
    })

    test('does not call init() when the engine has no loaded implementation', async () => {
      delete search.modules['custom-engine']
      ;(globalThis as any).WIKI.sites['site-i'] = {
        id: 'site-i',
        config: { search: { engine: 'db', engines: {} } }
      }
      ;(globalThis as any).WIKI.models = {
        sites: { updateSite: async () => true }
      }

      // -> `custom-engine` has a definition (so `buildEngineConfig` still runs) but no loaded module
      //    and no real `search.ts` on disk, so `ensureModule` resolves null and init() is never reached.
      const result = await search.selectEngine('site-i', 'custom-engine', { apiKey: 'k' })
      assert.equal(result, true)
    })

    test('does not call init() when the site write itself failed', async () => {
      const { calls: initCalls, module: fakeModule } = makeFakeSearchModule()
      search.modules['custom-engine'] = fakeModule
      ;(globalThis as any).WIKI.sites['site-j'] = {
        id: 'site-j',
        config: { search: { engine: 'db', engines: {} } }
      }
      ;(globalThis as any).WIKI.models = {
        sites: { updateSite: async () => false }
      }

      try {
        const result = await search.selectEngine('site-j', 'custom-engine', { apiKey: 'k' })
        assert.equal(result, false)
        assert.deepEqual(initCalls, [])
      } finally {
        delete search.modules['custom-engine']
      }
    })
  })
})

/**
 * `search.initActiveEngines()`, OpenProject #920's boot-time counterpart to `selectEngine()`: whatever
 * engine each site currently has active gets provisioned at boot, covering a site that selected a
 * non-`db` engine before this existed.
 */
describe('search.initActiveEngines()', () => {
  let previousWiki: any
  let previousDefinitions: SearchEngineDefinition[]

  const customDefinition: SearchEngineDefinition = {
    key: 'custom-engine',
    title: 'Custom Engine',
    description: 'A fake external engine.',
    vendor: 'Test',
    website: 'https://example.com',
    props: {
      apiKey: fakeProp({ default: '', type: 'string', title: 'API Key' })
    }
  }

  before(() => {
    previousWiki = (globalThis as any).WIKI
    previousDefinitions = search.definitions
    search.definitions = [customDefinition]
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
    search.definitions = previousDefinitions
  })

  test('provisions every site’s active engine with its resolved config', async () => {
    const { calls: dbCalls, module: dbModule } = makeFakeSearchModule()
    const { calls: customCalls, module: customModule } = makeFakeSearchModule()
    ;(globalThis as any).WIKI = {
      sites: {
        'site-default': { id: 'site-default', config: {} },
        'site-custom': {
          id: 'site-custom',
          config: {
            search: { engine: 'custom-engine', engines: { 'custom-engine': { apiKey: 'k' } } }
          }
        }
      },
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    }
    search.modules.db = dbModule
    search.modules['custom-engine'] = customModule

    await search.initActiveEngines()

    assert.deepEqual(dbCalls, ['init:site-default:{}'])
    assert.deepEqual(customCalls, [`init:site-custom:${JSON.stringify({ apiKey: 'k' })}`])
  })

  test('logs and continues past a site whose engine fails to initialize, rather than aborting the rest', async () => {
    const { calls: dbCalls, module: dbModule } = makeFakeSearchModule()
    const brokenModule: SearchModule = {
      ...dbModule,
      async init() {
        throw new Error('service unreachable')
      }
    }
    const warnings: { message: string; fields?: Record<string, any> }[] = []
    ;(globalThis as any).WIKI = {
      sites: {
        'site-broken': {
          id: 'site-broken',
          config: { search: { engine: 'broken-engine', engines: {} } }
        },
        'site-ok': { id: 'site-ok', config: {} }
      },
      logger: {
        info: () => {},
        error: () => {},
        warn: (_scope: string, message: string, fields?: Record<string, any>) =>
          warnings.push({ message, fields }),
        debug: () => {}
      }
    }
    search.modules.db = dbModule
    search.modules['broken-engine'] = brokenModule

    await assert.doesNotReject(search.initActiveEngines())

    assert.deepEqual(dbCalls, ['init:site-ok:{}'])
    assert.ok(warnings.some((w) => w.fields?.engine === 'broken-engine'))
  })

  /**
   * OpenProject #920 follow-up: `init()` reaches an external service with no bound of its own, so a
   * misconfigured host that never answers -- as opposed to one that actively refuses -- must not be
   * allowed to stall this sequential loop forever and, with it, every site after the hung one.
   */
  test('treats a site whose init() never settles as a failure, rather than blocking every other site', async (t) => {
    const { calls: dbCalls, module: dbModule } = makeFakeSearchModule()
    const hangingModule: SearchModule = {
      ...dbModule,
      init: () => new Promise<void>(() => {}) // never resolves or rejects
    }
    const warnings: { message: string; fields?: Record<string, any> }[] = []
    ;(globalThis as any).WIKI = {
      sites: {
        'site-hanging': {
          id: 'site-hanging',
          config: { search: { engine: 'hanging-engine', engines: {} } }
        },
        'site-ok': { id: 'site-ok', config: {} }
      },
      logger: {
        info: () => {},
        error: () => {},
        warn: (_scope: string, message: string, fields?: Record<string, any>) =>
          warnings.push({ message, fields }),
        debug: () => {}
      }
    }
    search.modules.db = dbModule
    search.modules['hanging-engine'] = hangingModule
    t.mock.timers.enable({ apis: ['setTimeout'] })

    try {
      const promise = search.initActiveEngines()
      // -> The timeout race is set up only after `ensureModule`'s own await resolves, so a couple of
      //    microtask/tick interleavings are needed before ticking meaningfully advances the clock --
      //    same technique as `models/pdfExport.test.ts`'s equivalent hang case.
      for (let i = 0; i < 10; i++) {
        await Promise.resolve()
        t.mock.timers.tick(20000)
      }
      await promise
    } finally {
      t.mock.timers.reset()
    }

    assert.deepEqual(dbCalls, ['init:site-ok:{}'])
    assert.ok(warnings.some((w) => w.fields?.engine === 'hanging-engine'))
    assert.ok(warnings.some((w) => /Timed out/.test(w.fields?.error?.message ?? '')))
  })

  /**
   * OpenProject #1848: sites are now provisioned concurrently, so N sites each timing out costs one
   * `ENGINE_INIT_TIMEOUT_MS` wait total, not N of them stacked up serially. Two sites here hang at once
   * -- if the old `for` loop were still in place, the second site's own timeout race wouldn't even be
   * set up until the first one's 30s race had already rejected, so settling this within a single
   * timeout window's worth of ticked time is only possible when both races run in parallel.
   */
  test('two sites hanging at once cost one timeout window, not one per hung site', async (t) => {
    const { calls: dbCalls, module: dbModule } = makeFakeSearchModule()
    const hangingModule: SearchModule = {
      ...dbModule,
      init: () => new Promise<void>(() => {}) // never resolves or rejects
    }
    const warnings: { message: string; fields?: Record<string, any> }[] = []
    ;(globalThis as any).WIKI = {
      sites: {
        'site-hanging-a': {
          id: 'site-hanging-a',
          config: { search: { engine: 'hanging-engine-a', engines: {} } }
        },
        'site-hanging-b': {
          id: 'site-hanging-b',
          config: { search: { engine: 'hanging-engine-b', engines: {} } }
        },
        'site-ok': { id: 'site-ok', config: {} }
      },
      logger: {
        info: () => {},
        error: () => {},
        warn: (_scope: string, message: string, fields?: Record<string, any>) =>
          warnings.push({ message, fields }),
        debug: () => {}
      }
    }
    search.modules.db = dbModule
    search.modules['hanging-engine-a'] = hangingModule
    search.modules['hanging-engine-b'] = hangingModule
    t.mock.timers.enable({ apis: ['setTimeout'] })

    let settled = false
    try {
      const promise = search.initActiveEngines().then(() => {
        settled = true
      })
      // -> Tick a total of 40s (< 2x the 30s timeout a serial second-site wait would need), in small
      //    increments with a microtask flush between each so both hanging sites' timers -- set up only
      //    after their own `ensureModule()` await resolves -- get a chance to be scheduled. If either
      //    hung site's race were still waiting on the other to finish first, this would not be enough
      //    ticked time for `initActiveEngines()` to settle.
      for (let i = 0; i < 8; i++) {
        await Promise.resolve()
        t.mock.timers.tick(5000)
      }
      await promise
    } finally {
      t.mock.timers.reset()
    }

    assert.equal(settled, true)
    assert.deepEqual(dbCalls, ['init:site-ok:{}'])
    assert.ok(warnings.some((w) => w.fields?.engine === 'hanging-engine-a'))
    assert.ok(warnings.some((w) => w.fields?.engine === 'hanging-engine-b'))
  })
})

/**
 * `index.ts`'s boot order, as a structural check against the file itself.
 *
 * Load-bearing since CORE-F5 phase 4: every search engine module now reads its per-site config
 * through `getEngineConfig()`, which completes the stored values with the props declared in that
 * engine's `definition.yml` — and those props only exist once `refreshFromDisk()` has read them off
 * disk. `azure-search` and `aws-cloudsearch` used to sidestep that by reading
 * `WIKI.sites[...].config.search.engines[key]` raw and re-applying each default by hand at every use
 * site; they no longer do, so the ordering `index.ts` has always had is now something a reorder could
 * silently break — an engine would come up with an empty config rather than a defaulted one.
 *
 * Text-level rather than behavioural because `index.ts` is a boot script with no seam to call into:
 * `postBoot()` connects to postgres, starts the scheduler and binds a port.
 */
describe("index.ts boots search's definitions before it provisions any engine", () => {
  test('refreshFromDisk() is called before initActiveEngines()', async () => {
    const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts')
    const source = await readFile(indexPath, 'utf8')

    // -> Matched with the `await ` prefix so a mention in a comment (or an unawaited call, which
    //    would break the ordering just as surely) cannot satisfy or skew this
    const refresh = source.indexOf('await WIKI.models.search.refreshFromDisk()')
    const init = source.indexOf('await WIKI.models.search.initActiveEngines()')

    assert.notEqual(refresh, -1, 'index.ts no longer awaits WIKI.models.search.refreshFromDisk()')
    assert.notEqual(init, -1, 'index.ts no longer awaits WIKI.models.search.initActiveEngines()')
    assert.ok(
      refresh < init,
      'index.ts must call search.refreshFromDisk() before search.initActiveEngines(): every engine resolves its config through getEngineConfig(), which needs the definitions loaded'
    )
  })
})
