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
 * (TEST-F6).
 *
 * `algolia`, `elasticsearch`, `azure-search` and `aws-cloudsearch` each used to restate these
 * thirteen claims in their own file — test-name-for-test-name in the first two, under different
 * describe names in the other two — over four sets of vendor fakes. That is four places to notice
 * when the contract itself moves: `externalBase.ts`'s `renamed()` re-indexing in place rather than
 * delete-then-add, `neverThrows`' promise that a page save survives an unreachable index, and
 * `shared.ts#toSearchPagesResult`'s rule that `results` and `totalHits` are both derived from the
 * rows an actor may actually READ (OpenProject #2151/#2156). Restated four times, three of them can
 * drift without anything failing.
 *
 * What stays in each engine's own `search.test.ts` is everything that is genuinely about a vendor:
 * its query translation (`buildFilters` / `buildEsQuery` / `buildFilter` / `buildStructuredQuery`),
 * its document shape, its index provisioning, its batching limits, its client caching, and whatever
 * it does that no other engine does — Azure's protected-content split query, CloudSearch's
 * per-document size ceiling, Elasticsearch's sequential-streaming rebuild, Algolia's oversized-page
 * diversion.
 *
 * The `db` engine is deliberately NOT run through this. It implements the bare `SearchModule`
 * interface rather than extending `ExternalSearchModule` (see that class's own doc comment): it has
 * no vendor client to fake, its `deleted`/`renamed` are genuinely different, and its suite is
 * DB-backed against real postgres — so wiring it here would mean asserting a contract it does not
 * have.
 */

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The site every contract test runs against. */
export const CONTRACT_SITE_ID = 'site-1'

/**
 * One row of a search response, in the only vocabulary every engine has in common.
 *
 * Each harness turns these into whatever its vendor actually returns — an Algolia hit's flat fields,
 * an Elasticsearch hit's `_source`, an Azure row's `document`, a CloudSearch hit's array-valued
 * `fields` — which is the same reason `shared.ts#filterVisible` takes a mapper rather than a row type.
 */
export interface SearchContractHit {
  id: string
  path: string
  locale?: string
  title?: string
  tags?: string[]
  /** Omitted entirely for a document indexed before the field existed (OpenProject #1125). */
  classification?: string
}

/**
 * One engine, wired to a fake vendor client, plus the readers the contract asserts through.
 *
 * Every method is about what the module DID, never about how this engine says it — that translation
 * is the harness's whole job, and is what lets thirteen claims be written once.
 */
export interface SearchContractHarness {
  /** The module under test. */
  mod: SearchModule
  /**
   * Params every `query()` in the contract carries, for an engine whose defaults would otherwise
   * take a different code path — `azure-search` and `aws-cloudsearch` both default
   * `hideProtectedContent` to `true`, whose split-query path each covers in its own file.
   */
  baseQuery?: Partial<SearchPagesParams>
  /** Replace this module's client with one that rejects, so `neverThrows` can be observed. */
  breakClient(): void
  /** Stage what the vendor answers the next `query()` with, and the total it claims to have matched. */
  setHits(hits: SearchContractHit[], reportedTotal?: number): void
  /** The window each `query()` actually asked the vendor for, in call order. */
  windows(): { offset: number; size: number }[]
  /** Ids written to the index by `created`/`updated`/`renamed`, in call order. */
  indexedIds(): string[]
  /** The `path` the last write to the index carried. */
  lastIndexedPath(): string | undefined
  /** Ids removed from the index by `deleted()`. */
  removedIds(): string[]
  /** Stage the site's pages, however this engine reads them during a rebuild. */
  setPages(pages: SearchIndexablePage[]): void
  /** Ids of every document `rebuild()` uploaded, across every batch. */
  rebuiltIds(): string[]
  /** How many bulk-upload calls `rebuild()` made. */
  uploadCalls(): number
}

export interface SearchContractOptions {
  /** Build a fresh module wired to fresh fakes. Called once per contract test, never shared. */
  makeModule(config: Record<string, any>): SearchContractHarness
  /** The engine's own config record, as the site stores it under `search.engines[<key>]`. */
  config: Record<string, any>
  /** The whole site config to install as `WIKI.sites[CONTRACT_SITE_ID].config`. */
  siteConfig: Record<string, any>
}

/** Swap `checkAccess` for the duration of one test, restoring it however the test ends. */
async function withCheckAccess(
  checkAccess: (actor: AccessActor, permission: string, page: any) => boolean,
  body: () => Promise<void>
): Promise<void> {
  const previous = WIKI.models.groups.checkAccess
  WIKI.models.groups.checkAccess = checkAccess as typeof WIKI.models.groups.checkAccess
  try {
    await body()
  } finally {
    WIKI.models.groups.checkAccess = previous
  }
}

/** The actor every filtering claim below runs as: a real actor, holding nothing in particular. */
const ACTOR = { groupIds: [], permissions: [] } as unknown as AccessActor

/**
 * Emit the thirteen-test `SearchModule` contract for one engine.
 *
 * @param name The engine's module key, which every generated test name is prefixed with.
 */
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
      //    own `definition.yml`, so the definitions have to be read off disk first — exactly the
      //    order `index.ts` boots in (`refreshFromDisk()` before `initActiveEngines()`).
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
     * `externalBase.ts#renamed`: this schema's `pages.id` is a stable UUID a move never touches, so a
     * rename is an ordinary re-index of the same document — never a delete followed by an add, which
     * would leave the page briefly unfindable.
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
     * `externalBase.ts#neverThrows`: a page that saved correctly must not report failure because an
     * external index could not be reached. A later `rebuild()` is what puts the missed write right.
     */
    test(`${name}: an index write never throws when the vendor fails`, async () => {
      const harness = makeModule(config)
      harness.breakClient()

      await assert.doesNotReject(harness.mod.created(makeIndexablePage()))
    })

    /**
     * OpenProject #2156: `offset`/`limit` are no longer sent through as the vendor's own paging —
     * page-rule filtering happens after the query, so every engine scans a bounded window from the
     * start and applies the caller's own pagination in JS, over the filtered set.
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
     * `shared.ts#filterVisible` runs `checkAccess` per row rather than folding the rules into the
     * vendor's own filter, which none of them can express.
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
     * OpenProject #2151/#2156: the old arithmetic (the vendor's own total, minus this page's rows,
     * plus the visible ones) leaked matches the caller was never checked against into `totalHits` —
     * so `?query=<phrase>&limit=1` could confirm a phrase existed inside a page they could not open.
     * A count derived from `visible` alone can only ever be a floor.
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
          // -> Exactly the readable count within the scanned window, never the vendor's 100
          assert.equal(result.totalHits, 2)
        }
      )
    })

    /**
     * OpenProject #1125: a CLASSIFICATION page rule is decided against the level indexed WITH the
     * document, not a hardcoded `null` — which every engine used to pass, silently making every rule
     * of that kind fall through to the unknown-classification treatment.
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

    /**
     * No actor means nothing is filtered: an internal caller, or a configuration that trusts the
     * caller to have filtered already. `checkAccess` is not consulted at all in that case
     * (`shared.ts#filterVisible`).
     */
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
