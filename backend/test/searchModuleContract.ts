import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installTestWiki } from './mocks.ts'
import { makeIndexablePage } from './builders.ts'
import { search } from '../models/search.ts'
import type { AccessActor } from '../models/groups.ts'
import type { SearchIndexablePage, SearchModule, SearchPagesParams } from '../models/search.ts'

/**
 * The contract every external search engine module owes `models/search.ts`, run once per engine
 * rather than restated in each engine's own file over its own vendor fakes: restated per engine, all
 * but one copy can drift without anything failing. What stays in an engine's own `search.test.ts` is
 * what is genuinely about a vendor — query translation, document shape, index provisioning, batching
 * limits, client caching.
 *
 * The `db` engine is deliberately NOT run through this. It implements the bare `SearchModule`
 * interface rather than extending `ExternalSearchModule`: it has no vendor client to fake and its
 * `deleted`/`renamed` are genuinely different, so wiring it here would assert a contract it does not
 * have.
 */

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

export const CONTRACT_SITE_ID = 'site-1'

export interface SearchContractHit {
  id: string
  path: string
  locale?: string
  title?: string
  tags?: string[]
  /** Omitted entirely by a document indexed before the field existed. */
  classification?: string
}

/**
 * Every method is about what the module DID, never about how this engine says it — that translation
 * is the harness's whole job, and is what lets each claim be written once.
 */
export interface SearchContractHarness {
  mod: SearchModule
  /**
   * Carried by every `query()` in the contract, for an engine whose defaults would otherwise take a
   * different code path — `azure-search` defaults `hideProtectedContent` to `true`.
   */
  baseQuery?: Partial<SearchPagesParams>
  /** Make this module's client reject, so `neverThrows` can be observed. */
  breakClient(): void
  /** `reportedTotal` is what the vendor CLAIMS to have matched, independent of `hits.length`. */
  setHits(hits: SearchContractHit[], reportedTotal?: number): void
  windows(): { offset: number; size: number }[]
  indexedIds(): string[]
  lastIndexedPath(): string | undefined
  removedIds(): string[]
  setPages(pages: SearchIndexablePage[]): void
  rebuiltIds(): string[]
  uploadCalls(): number
}

export interface SearchContractOptions {
  /** Called once per contract test, never shared: a fresh module wired to fresh fakes. */
  makeModule(config: Record<string, any>): SearchContractHarness
  /** The engine's own config record, as the site stores it under `search.engines[<key>]`. */
  config: Record<string, any>
  /** The whole site config to install as `CARDINAL.sites[CONTRACT_SITE_ID].config`. */
  siteConfig: Record<string, any>
}

async function withCheckAccess(
  checkAccess: (actor: AccessActor, permission: string, page: any) => boolean,
  body: () => Promise<void>
): Promise<void> {
  const previous = CARDINAL.models.groups.checkAccess
  CARDINAL.models.groups.checkAccess = checkAccess as typeof CARDINAL.models.groups.checkAccess
  try {
    await body()
  } finally {
    CARDINAL.models.groups.checkAccess = previous
  }
}

/** A real actor holding nothing in particular: each claim's filtering comes from `checkAccess`. */
const ACTOR = { groupIds: [], permissions: [] } as unknown as AccessActor

export function runSearchModuleContract(name: string, options: SearchContractOptions): void {
  const { makeModule, config, siteConfig } = options
  const siteId = CONTRACT_SITE_ID

  describe('SearchModule contract', () => {
    let wikiHandle: { restore(): void }

    before(async () => {
      wikiHandle = installTestWiki({
        SERVERPATH: backendDir,
        sites: { [siteId]: { config: siteConfig } },
        models: { groups: { checkAccess: () => true } }
      })
      // -> `getEngineConfig()` completes a stored config from the props each engine declares in its
      //    own `definition.yml`, so the definitions have to be read off disk first — the same order
      //    `index.ts` boots in.
      await search.refreshFromDisk()
    })

    after(() => {
      wikiHandle.restore()
    })

    test(`${name}: created() indexes the page under its own id`, async () => {
      const harness = makeModule(config)
      await harness.mod.created(makeIndexablePage())

      assert.deepEqual(harness.indexedIds(), ['p1'])
      assert.deepEqual(harness.removedIds(), [])
    })

    test(`${name}: updated() re-indexes the same document, keeping it in sync`, async () => {
      const harness = makeModule(config)
      await harness.mod.updated(makeIndexablePage({ path: 'docs/renamed' }))

      assert.deepEqual(harness.indexedIds(), ['p1'])
      assert.equal(harness.lastIndexedPath(), 'docs/renamed')
    })

    test(`${name}: deleted() removes the document by id`, async () => {
      const harness = makeModule(config)
      await harness.mod.deleted(siteId, 'p1')

      assert.deepEqual(harness.removedIds(), ['p1'])
      assert.deepEqual(harness.indexedIds(), [])
    })

    /**
     * `pages.id` is a stable UUID a move never touches, so a rename re-indexes the same document —
     * a delete followed by an add would leave the page briefly unfindable.
     */
    test(`${name}: renamed() re-indexes in place rather than delete+add`, async () => {
      const harness = makeModule(config)
      await harness.mod.renamed(
        siteId,
        makeIndexablePage({ path: 'docs/new-path' }),
        'docs/old',
        'en'
      )

      assert.deepEqual(harness.removedIds(), [])
      assert.deepEqual(harness.indexedIds(), ['p1'])
      assert.equal(harness.lastIndexedPath(), 'docs/new-path')
    })

    /**
     * A page that saved correctly must not report failure because an external index could not be
     * reached. A later `rebuild()` is what puts the missed write right.
     */
    test(`${name}: an index write never throws when the vendor fails`, async () => {
      const harness = makeModule(config)
      harness.breakClient()

      await assert.doesNotReject(harness.mod.created(makeIndexablePage()))
    })

    /**
     * Page-rule filtering happens after the query, so `offset`/`limit` cannot be delegated to the
     * vendor's own paging.
     */
    test(`${name}: query() scans from the start with a bounded window, whatever offset/limit was asked for`, async () => {
      const harness = makeModule(config)
      harness.setHits([{ id: 'p1', path: 'a' }], 1)

      await harness.mod.query({
        siteId,
        query: 'kangaroo',
        offset: 10,
        limit: 5,
        ...harness.baseQuery
      })

      const windows = harness.windows()
      assert.equal(windows.length, 1)
      assert.equal(windows[0]!.offset, 0)
      assert.ok(
        windows[0]!.size > 5,
        `expected a bounded scan window larger than the requested page size, got ${windows[0]!.size}`
      )
    })

    test(`${name}: query() applies the caller's offset/limit in JS, over the filtered set`, async () => {
      const harness = makeModule(config)
      harness.setHits(
        [
          { id: 'p1', path: 'a' },
          { id: 'p2', path: 'b' },
          { id: 'p3', path: 'c' }
        ],
        3
      )

      const result = await harness.mod.query({
        siteId,
        query: 'x',
        offset: 1,
        limit: 1,
        ...harness.baseQuery
      })

      assert.equal(result.results.length, 1)
      assert.equal(result.results[0]!.path, 'b')
      assert.equal(result.totalHits, 3)
      assert.equal(harness.windows().length, 1)
    })

    /**
     * Search must not be a way around page permissions — a title and an excerpt are content too, so
     * `checkAccess` runs per row rather than the rules being folded into the vendor's own filter,
     * which none of them can express.
     */
    test(`${name}: query() drops a hit checkAccess denies`, async () => {
      const harness = makeModule(config)
      harness.setHits(
        [
          { id: 'p1', path: 'open' },
          { id: 'p2', path: 'secret' }
        ],
        2
      )

      await withCheckAccess(
        (_actor, _permission, page) => page.path !== 'secret',
        async () => {
          const result = await harness.mod.query({
            siteId,
            query: '',
            actor: ACTOR,
            ...harness.baseQuery
          })
          assert.equal(result.results.length, 1)
          assert.equal(result.results[0]!.path, 'open')
          assert.equal(result.totalHits, 1)
          assert.equal(result.totalHitsApproximate, true)
        }
      )
    })

    /**
     * Arithmetic over the vendor's own total would leak matches the caller was never checked
     * against into `totalHits` — `?query=<phrase>&limit=1` could then confirm a phrase existed
     * inside a page they cannot open. Derived from the visible rows alone, it can only be a floor.
     */
    test(`${name}: totalHits never reflects the vendor's own count beyond what was checked`, async () => {
      const harness = makeModule(config)
      harness.setHits(
        [
          { id: 'p1', path: 'open-1' },
          { id: 'p2', path: 'secret-1' },
          { id: 'p3', path: 'open-2' }
        ],
        // -> The vendor reports 100 matches across many pages this call never fetched.
        100
      )

      await withCheckAccess(
        (_actor, _permission, page) => !page.path.startsWith('secret'),
        async () => {
          const result = await harness.mod.query({
            siteId,
            query: 'x',
            offset: 0,
            actor: ACTOR,
            ...harness.baseQuery
          })
          assert.equal(result.results.length, 2)
          assert.equal(result.totalHits, 2)
        }
      )
    })

    /**
     * A CLASSIFICATION page rule is decided against the level indexed WITH the document; passing a
     * hardcoded `null` instead silently makes every rule of that kind fall through to the
     * unknown-classification treatment.
     */
    test(`${name}: query() passes each hit's own indexed classification to checkAccess`, async () => {
      const harness = makeModule(config)
      harness.setHits([{ id: 'p1', path: 'restricted', classification: 'classification-x' }], 1)
      const seen: unknown[] = []

      await withCheckAccess(
        (_actor, _permission, page) => {
          seen.push(page.classification)
          return true
        },
        async () => {
          await harness.mod.query({ siteId, query: '', actor: ACTOR, ...harness.baseQuery })
          assert.deepEqual(seen, ['classification-x'])
        }
      )
    })

    /** No actor means an internal caller, or one trusted to have filtered already. */
    test(`${name}: query() with no actor returns every hit unfiltered`, async () => {
      const harness = makeModule(config)
      harness.setHits(
        [
          { id: 'p1', path: 'a' },
          { id: 'p2', path: 'b' }
        ],
        2
      )

      await withCheckAccess(
        () => assert.fail('checkAccess must not be consulted for an actorless query'),
        async () => {
          const result = await harness.mod.query({ siteId, query: '', ...harness.baseQuery })
          assert.equal(result.results.length, 2)
          assert.equal(result.totalHits, 2)
          assert.equal(result.totalHitsApproximate, false)
        }
      )
    })

    test(`${name}: rebuild() uploads every page of the site and reports per-locale counts`, async () => {
      const harness = makeModule(config)
      harness.setPages([
        makeIndexablePage({ id: 'p1', locale: 'en' }),
        makeIndexablePage({ id: 'p2', locale: 'en' }),
        makeIndexablePage({ id: 'p3', locale: 'fr' })
      ])

      const result = await harness.mod.rebuild(siteId)

      assert.deepEqual(harness.rebuiltIds().sort(), ['p1', 'p2', 'p3'])
      assert.equal(result.pages, 3)
      assert.deepEqual(
        result.locales
          .map((entry) => ({ locale: entry.locale, pages: entry.pages }))
          .sort((a, b) => a.locale.localeCompare(b.locale)),
        [
          { locale: 'en', pages: 2 },
          { locale: 'fr', pages: 1 }
        ]
      )
    })

    test(`${name}: an empty site uploads nothing`, async () => {
      const harness = makeModule(config)
      harness.setPages([])

      const result = await harness.mod.rebuild(siteId)

      assert.equal(harness.uploadCalls(), 0)
      assert.deepEqual(harness.rebuiltIds(), [])
      assert.equal(result.pages, 0)
    })
  })
}
