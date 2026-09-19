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

/** Shaped the way `parseModuleProps` normalizes a `definition.yml` entry, not as it is written there. */
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

/** Cast through `unknown` rather than filled field-for-field: no hook under test reads a column
 *  beyond these, and re-describing every `pages` column here would only duplicate `db/schema.ts`. */
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
      vendor: 'Cardinal.js',
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
    //    deliberately absent from props.
    assert.equal((definition.props as Record<string, unknown>).dictOverrides, undefined)
  })
})

/**
 * `CARDINAL.SERVERPATH` points at a throwaway fixture directory rather than the real repo, so the
 * scanning/sorting/prop-normalization logic is covered without depending on what actually ships
 * under `modules/search/*`.
 */
describe('search.refreshFromDisk() / hasImplementation() / getDefinition()', () => {
  let dir: string
  let previousWiki: any

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cardinaljs-search-model-test-'))

    await mkdir(path.join(dir, 'modules/search/db'), { recursive: true })
    await writeFile(
      path.join(dir, 'modules/search/db/definition.yml'),
      [
        'title: Database',
        'description: PostgreSQL full-text search.',
        'vendor: Cardinal.js',
        'website: https://js.wiki',
        'props:',
        '  termHighlighting:',
        '    type: Boolean',
        '    title: Term Highlighting',
        '    order: 100'
      ].join('\n')
    )

    // -> Sorts after `db` by title, and is the only one of the two with an implementation.
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

    previousWiki = (globalThis as any).CARDINAL
    ;(globalThis as any).CARDINAL = {
      SERVERPATH: dir,
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    }
  })

  after(async () => {
    ;(globalThis as any).CARDINAL = previousWiki
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
 * `ensureModule()`'s dynamic import is a fixed relative specifier resolved from `models/search.ts`'s
 * own location, not something built off `CARDINAL.SERVERPATH` — so these fixtures are real modules
 * written under the actual `backend/modules/search/` directory (cleaned up in `after`) rather than a
 * tmp dir, with `CARDINAL.SERVERPATH` pointed at the backend root so `hasImplementation()`'s gate agrees.
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

    previousWiki = (globalThis as any).CARDINAL
    ;(globalThis as any).CARDINAL = {
      SERVERPATH: backendDir,
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    }
  })

  after(async () => {
    ;(globalThis as any).CARDINAL = previousWiki
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

describe('search.getConfig()', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).CARDINAL
    ;(globalThis as any).CARDINAL = {
      sites: {},
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    }
  })

  after(() => {
    ;(globalThis as any).CARDINAL = previousWiki
  })

  test('reads dictOverrides off the named site, not off any other site', () => {
    ;(globalThis as any).CARDINAL.sites['site-a'] = {
      id: 'site-a',
      config: {
        search: {
          engine: 'db',
          config: { dictOverrides: { en: 'english' } }
        }
      }
    }
    ;(globalThis as any).CARDINAL.sites['site-b'] = {
      id: 'site-b',
      config: { search: { engine: 'db', config: { dictOverrides: {} } } }
    }

    assert.deepEqual(search.getConfig('site-a'), {
      dictOverrides: { en: 'english' },
      semanticEnabled: false
    })
    assert.deepEqual(search.getConfig('site-b'), {
      dictOverrides: {},
      semanticEnabled: false
    })
  })

  test('reads semanticEnabled off the named site', () => {
    ;(globalThis as any).CARDINAL.sites['site-c'] = {
      id: 'site-c',
      config: { search: { engine: 'db', config: { dictOverrides: {}, semanticEnabled: true } } }
    }

    assert.deepEqual(search.getConfig('site-c'), {
      dictOverrides: {},
      semanticEnabled: true
    })
  })

  test('defaults to an empty dictOverrides and semanticEnabled: false for a site with no search config', () => {
    ;(globalThis as any).CARDINAL.sites['site-bare'] = { id: 'site-bare', config: {} }

    assert.deepEqual(search.getConfig('site-bare'), {
      dictOverrides: {},
      semanticEnabled: false
    })
  })

  test('defaults the same way for a siteId nothing in CARDINAL.sites knows about', () => {
    assert.deepEqual(search.getConfig('site-nonexistent'), {
      dictOverrides: {},
      semanticEnabled: false
    })
  })
})

/**
 * Modules are injected straight into `search.modules` rather than through real fixture directories:
 * `ensureModule()` checks that cache before touching disk, so seeding it exercises the dispatcher's
 * resolution without needing a `db/search.ts` capable of running real SQL against a `CARDINAL.db`
 * this suite has none of.
 */
describe('search dispatcher (query/rebuild/created/updated/deleted/renamed)', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).CARDINAL
    ;(globalThis as any).CARDINAL = {
      sites: {},
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    }
  })

  after(() => {
    ;(globalThis as any).CARDINAL = previousWiki
  })

  test('a site with no configured engine dispatches to the db module', async () => {
    const { calls, module: dbModule } = makeFakeSearchModule()
    search.modules.db = dbModule
    ;(globalThis as any).CARDINAL.sites['site-default'] = { id: 'site-default', config: {} }

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
    ;(globalThis as any).CARDINAL.sites['site-custom'] = {
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

    await search.renamed('site-default', page, 'old/path', 'de')

    assert.deepEqual(calls, ['renamed:site-default:page-moved:de/old/path'])
  })

  /** `getActiveEngine` is private, so its two failure branches are exercised through `query()`. */
  test('falls back to db when the configured engine has no loaded implementation', async () => {
    const { calls, module: dbModule } = makeFakeSearchModule()
    search.modules.db = dbModule
    delete search.modules['missing-engine']
    ;(globalThis as any).CARDINAL.sites['site-missing'] = {
      id: 'site-missing',
      config: { search: { engine: 'missing-engine' } }
    }

    await search.query({ siteId: 'site-missing', query: 'wiki' })

    assert.deepEqual(calls, ['query:site-missing:wiki'])
  })

  test('throws when neither the configured engine nor db has a loaded implementation', async () => {
    delete search.modules.db
    delete search.modules['missing-engine']
    ;(globalThis as any).CARDINAL.sites['site-none'] = {
      id: 'site-none',
      config: { search: { engine: 'missing-engine' } }
    }

    await assert.rejects(
      () => search.query({ siteId: 'site-none', query: 'wiki' }),
      /No search engine implementation is available/
    )
  })
})

describe('search engine picker (getSiteEngines/buildEngineConfig/validateEngineConfig/selectEngine)', () => {
  let previousWiki: any
  let previousDefinitions: SearchEngineDefinition[]

  const dbDefinition: SearchEngineDefinition = {
    key: 'db',
    title: 'Database',
    description: 'PostgreSQL full-text search.',
    vendor: 'Cardinal.js',
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

  /** A third fixture, so adding a `required` prop and a `pattern` prop leaves the other two
   *  definitions' tests undisturbed. */
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
    previousWiki = (globalThis as any).CARDINAL
    ;(globalThis as any).CARDINAL = {
      sites: {},
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
    }
    previousDefinitions = search.definitions
    search.definitions = [dbDefinition, customDefinition, strictDefinition]
  })

  after(() => {
    ;(globalThis as any).CARDINAL = previousWiki
    search.definitions = previousDefinitions
  })

  describe('getSiteEngines()', () => {
    test('lists every definition, marking the site’s configured engine as selected', async () => {
      ;(globalThis as any).CARDINAL.sites['site-a'] = {
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
      ;(globalThis as any).CARDINAL.sites['site-bare'] = { id: 'site-bare', config: {} }

      const engines = await search.getSiteEngines('site-bare')

      assert.equal(engines.find((e) => e.key === 'db')!.isSelected, true)
    })

    test('hasImplementation reflects whether a search.ts sits next to the definition', async () => {
      ;(globalThis as any).CARDINAL.sites['site-bare'] = { id: 'site-bare', config: {} }

      const engines = await search.getSiteEngines('site-bare')

      // -> Neither fixture definition has a sibling search.ts under the real modules/search tree
      assert.equal(engines.find((e) => e.key === 'db')!.hasImplementation, false)
      assert.equal(engines.find((e) => e.key === 'custom-engine')!.hasImplementation, false)
    })

    test('completes stored config with the engine defaults for a prop never saved', async () => {
      ;(globalThis as any).CARDINAL.sites['site-c'] = {
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
      ;(globalThis as any).CARDINAL.sites['site-d'] = {
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
      ;(globalThis as any).CARDINAL.sites['site-e'] = {
        id: 'site-e',
        config: {
          search: {
            engine: 'custom-engine',
            engines: { 'custom-engine': { apiKey: 'super-secret-key', mode: 'accurate' } }
          }
        }
      }

      const unmasked = await search.getSiteEngines('site-e')
      assert.equal(
        unmasked.find((e) => e.key === 'custom-engine')!.config.apiKey,
        'super-secret-key'
      )

      const masked = await search.getSiteEngines('site-e', { mask: true })
      const custom = masked.find((e) => e.key === 'custom-engine')!
      assert.equal(custom.config.apiKey, '********')
      assert.equal(custom.config.mode, 'accurate')
    })
  })

  describe('getEngineConfig()', () => {
    test('reads one engine’s stored config for a site, completed with defaults', () => {
      ;(globalThis as any).CARDINAL.sites['site-f'] = {
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
      ;(globalThis as any).CARDINAL.sites['site-g'] = { id: 'site-g', config: {} }

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
      // -> `hosts` is not `required`, and a `pattern` is only checked once a value is non-empty.
      assert.equal(search.validateEngineConfig('strict-engine', { apiKey: 'k' }), null)
    })
  })

  describe('selectEngine()', () => {
    test('writes engine + built config through CARDINAL.models.sites.updateSite', async () => {
      const calls: any[] = []
      ;(globalThis as any).CARDINAL.sites['site-e'] = {
        id: 'site-e',
        config: { search: { engine: 'db', engines: {} } }
      }
      ;(globalThis as any).CARDINAL.models = {
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
      ;(globalThis as any).CARDINAL.sites['site-f'] = {
        id: 'site-f',
        config: {
          search: {
            engine: 'db',
            engines: { 'custom-engine': { apiKey: 'kept-key', mode: 'accurate' } }
          }
        }
      }
      let written: any
      ;(globalThis as any).CARDINAL.models = {
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

    test('calls the newly selected engine’s init() with the config that was just built and stored', async () => {
      const { calls: initCalls, module: fakeModule } = makeFakeSearchModule()
      search.modules['custom-engine'] = fakeModule
      ;(globalThis as any).CARDINAL.sites['site-h'] = {
        id: 'site-h',
        config: { search: { engine: 'db', engines: {} } }
      }
      ;(globalThis as any).CARDINAL.models = {
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
      ;(globalThis as any).CARDINAL.sites['site-i'] = {
        id: 'site-i',
        config: { search: { engine: 'db', engines: {} } }
      }
      ;(globalThis as any).CARDINAL.models = {
        sites: { updateSite: async () => true }
      }

      // -> A definition exists (so `buildEngineConfig` still runs), but with no loaded module and no
      //    `search.ts` on disk `ensureModule` resolves null and `init()` is never reached.
      const result = await search.selectEngine('site-i', 'custom-engine', { apiKey: 'k' })
      assert.equal(result, true)
    })

    test('does not call init() when the site write itself failed', async () => {
      const { calls: initCalls, module: fakeModule } = makeFakeSearchModule()
      search.modules['custom-engine'] = fakeModule
      ;(globalThis as any).CARDINAL.sites['site-j'] = {
        id: 'site-j',
        config: { search: { engine: 'db', engines: {} } }
      }
      ;(globalThis as any).CARDINAL.models = {
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
    previousWiki = (globalThis as any).CARDINAL
    previousDefinitions = search.definitions
    search.definitions = [customDefinition]
  })

  after(() => {
    ;(globalThis as any).CARDINAL = previousWiki
    search.definitions = previousDefinitions
  })

  test('provisions every site’s active engine with its resolved config', async () => {
    const { calls: dbCalls, module: dbModule } = makeFakeSearchModule()
    const { calls: customCalls, module: customModule } = makeFakeSearchModule()
    ;(globalThis as any).CARDINAL = {
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

  test('a site whose engine has no implementation on disk falls back to db and logs once', async () => {
    const { calls: dbCalls, module: dbModule } = makeFakeSearchModule()
    const warnings: { message: string; fields?: Record<string, any> }[] = []
    ;(globalThis as any).CARDINAL = {
      sites: {
        'site-retired': {
          id: 'site-retired',
          config: { search: { engine: 'aws-cloudsearch', engines: {} } }
        }
      },
      logger: {
        info: () => {},
        error: () => {},
        warn: (_scope: string, message: string, fields?: Record<string, any>) =>
          warnings.push({ message, fields }),
        debug: () => {}
      }
    }
    // -> Registered in neither `search.modules` nor `search.definitions` — the state after a module
    //    directory is deleted from disk, where `ensureModule()` cache-misses and finds nothing.
    search.modules.db = dbModule
    delete search.modules['aws-cloudsearch']

    await search.initActiveEngines()

    assert.deepEqual(
      dbCalls,
      ['init:site-retired:{}'],
      'db must still be provisioned as the fallback'
    )
    assert.equal(warnings.length, 1, 'exactly one warning, not one per query')
    assert.equal(
      warnings[0]!.message,
      'configured engine has no implementation, falling back to db'
    )
    assert.deepEqual(warnings[0]!.fields, { engine: 'aws-cloudsearch', site: 'site-retired' })
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
    ;(globalThis as any).CARDINAL = {
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

  test('treats a site whose init() never settles as a failure, rather than blocking every other site', async (t) => {
    const { calls: dbCalls, module: dbModule } = makeFakeSearchModule()
    const hangingModule: SearchModule = {
      ...dbModule,
      init: () => new Promise<void>(() => {})
    }
    const warnings: { message: string; fields?: Record<string, any> }[] = []
    ;(globalThis as any).CARDINAL = {
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
      // -> The timeout race is set up only after `ensureModule`'s own await resolves, so ticking
      //    only advances a timer that exists after a few microtask interleavings.
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

  test('two sites hanging at once cost one timeout window, not one per hung site', async (t) => {
    const { calls: dbCalls, module: dbModule } = makeFakeSearchModule()
    const hangingModule: SearchModule = {
      ...dbModule,
      init: () => new Promise<void>(() => {})
    }
    const warnings: { message: string; fields?: Record<string, any> }[] = []
    ;(globalThis as any).CARDINAL = {
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
      // -> 40s of ticked time in all, under the two stacked 30s waits a serial second site would
      //    need: this settles only because both hung sites' timeout races run in parallel. Small
      //    increments with a microtask flush between, so both timers -- set up only after their own
      //    `ensureModule()` await resolves -- get a chance to be scheduled.
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
 * Text-level rather than behavioural because `index.ts` is a boot script with no seam to call into:
 * `postBoot()` connects to postgres, starts the scheduler and binds a port.
 */
describe("index.ts boots search's definitions before it provisions any engine", () => {
  test('refreshFromDisk() is called before initActiveEngines()', async () => {
    const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts')
    const source = await readFile(indexPath, 'utf8')

    // -> The `await ` prefix keeps a mention in a comment -- or an unawaited call, which would break
    //    the ordering just as surely -- from satisfying or skewing this.
    const refresh = source.indexOf('await CARDINAL.models.search.refreshFromDisk()')
    const init = source.indexOf('await CARDINAL.models.search.initActiveEngines()')

    assert.notEqual(
      refresh,
      -1,
      'index.ts no longer awaits CARDINAL.models.search.refreshFromDisk()'
    )
    assert.notEqual(
      init,
      -1,
      'index.ts no longer awaits CARDINAL.models.search.initActiveEngines()'
    )
    assert.ok(
      refresh < init,
      'index.ts must call search.refreshFromDisk() before search.initActiveEngines(): every engine resolves its config through getEngineConfig(), which needs the definitions loaded'
    )
  })
})
