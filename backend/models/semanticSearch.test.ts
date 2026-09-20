import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { installTestWiki } from '../test/mocks.ts'
import { groups as groupsTable, sites as sitesTable } from '../db/schema.ts'
import type { SiteRow } from '../db/schema.ts'
import {
  HOP2_DISTANCE_PENALTY,
  HOP2_SEED_COUNT,
  SEMANTIC_SCAN_CAP,
  annSearch,
  bestChunkPerPage,
  dedupeAndRank,
  mergeHopResults,
  runHop2,
  search,
  selectHop2Seeds,
  toVectorLiteral
} from './semanticSearch.ts'
import type { SemanticChunkMatch } from './semanticSearch.ts'
import type { PageActor, PageInput } from './pages.ts'
import type { GroupRule } from './groups.ts'

describe('semanticSearch: toVectorLiteral', () => {
  test('serializes a vector into pgvector input format', () => {
    assert.equal(toVectorLiteral([0.1, 0.2, 0.3]), '[0.1,0.2,0.3]')
  })

  test('rejects an empty vector', () => {
    assert.throws(() => toVectorLiteral([]), /must not be empty/)
  })

  test('rejects a non-finite component', () => {
    assert.throws(() => toVectorLiteral([0.1, Number.NaN, 0.3]), /finite numbers/)
    assert.throws(() => toVectorLiteral([0.1, Number.POSITIVE_INFINITY]), /finite numbers/)
  })
})

const DIMS = 384

/**
 * Two different indices are orthogonal (cosine distance `1`), the same index identical (distance
 * `0`) — exact, hand-checkable distances with no real embedding model involved.
 */
function basisVector(index: number): number[] {
  const v = Array.from({ length: DIMS }, () => 0)
  v[index] = 1
  return v
}

/** Cosine distance depends only on coordinates non-zero in either operand, so trailing zeros let a
 *  short hand-written literal (`[0.9, 0.1, 0]`) keep its intended distance in the `vector(DIMS)`
 *  column every test here shares. */
function pad(vector: number[]): number[] {
  return [...vector, ...Array.from({ length: DIMS - vector.length }, () => 0)]
}

function makeRow(overrides: Partial<SemanticChunkMatch> = {}): SemanticChunkMatch {
  return {
    pageId: 'page-1',
    chunkIndex: 0,
    chunkText: 'irrelevant',
    embedding: basisVector(0),
    distance: 0,
    path: 'irrelevant',
    locale: 'en',
    title: 'irrelevant',
    description: null,
    icon: null,
    tags: [],
    classification: null,
    ...overrides
  }
}

describe('semanticSearch: selectHop2Seeds', () => {
  test("picks the top HOP2_SEED_COUNT distinct pages by each page's own best (lowest-distance) chunk", () => {
    const rows: SemanticChunkMatch[] = [
      makeRow({ pageId: 'page-a', chunkIndex: 0, distance: 0.5 }),
      makeRow({ pageId: 'page-a', chunkIndex: 1, distance: 0.1 }),
      makeRow({ pageId: 'page-b', chunkIndex: 0, distance: 0.2 }),
      makeRow({ pageId: 'page-c', chunkIndex: 0, distance: 0.3 }),
      makeRow({ pageId: 'page-d', chunkIndex: 0, distance: 0.4 })
    ]

    const seeds = selectHop2Seeds(rows)

    assert.equal(seeds.length, HOP2_SEED_COUNT)
    assert.deepEqual(
      seeds.map((s) => [s.pageId, s.chunkIndex]),
      [
        ['page-a', 1],
        ['page-b', 0],
        ['page-c', 0]
      ]
    )
  })

  test('returns fewer than HOP2_SEED_COUNT seeds when hop 1 found fewer distinct pages', () => {
    const rows: SemanticChunkMatch[] = [
      makeRow({ pageId: 'page-a', chunkIndex: 0, distance: 0.5 }),
      makeRow({ pageId: 'page-a', chunkIndex: 1, distance: 0.1 }),
      makeRow({ pageId: 'page-b', chunkIndex: 0, distance: 0.2 })
    ]

    const seeds = selectHop2Seeds(rows)

    assert.equal(seeds.length, 2)
    assert.deepEqual(
      seeds.map((s) => s.pageId),
      ['page-a', 'page-b']
    )
  })

  test('returns nothing for an empty hop-1 result set', () => {
    assert.deepEqual(selectHop2Seeds([]), [])
  })

  test('a page with multiple chunks counts once, by its best chunk', () => {
    const rows = [
      makeRow({ pageId: 'page-a', chunkIndex: 0, distance: 0.5 }),
      makeRow({ pageId: 'page-a', chunkIndex: 1, distance: 0.1 })
    ]
    const seeds = selectHop2Seeds(rows, 3)
    assert.equal(seeds.length, 1)
    assert.equal(seeds[0]!.distance, 0.1)
  })
})

describe('semanticSearch: merge/rank/paginate', () => {
  function makeMatch(
    overrides: Partial<SemanticChunkMatch> & { pageId: string; distance: number }
  ): SemanticChunkMatch {
    return {
      path: `/${overrides.pageId}`,
      locale: 'en',
      title: overrides.pageId,
      description: null,
      icon: null,
      tags: [],
      classification: null,
      chunkText: 'chunk text',
      chunkIndex: 0,
      embedding: [0, 0, 0],
      ...overrides
    }
  }

  describe('bestChunkPerPage', () => {
    test('keeps only the lowest-distance chunk per page', () => {
      const rows = [
        makeMatch({ pageId: 'a', chunkIndex: 0, distance: 0.5 }),
        makeMatch({ pageId: 'a', chunkIndex: 1, distance: 0.2 }),
        makeMatch({ pageId: 'b', chunkIndex: 0, distance: 0.9 })
      ]
      const best = bestChunkPerPage(rows)
      assert.equal(best.size, 2)
      assert.equal(best.get('a')?.chunkIndex, 1)
      assert.equal(best.get('a')?.distance, 0.2)
      assert.equal(best.get('b')?.distance, 0.9)
    })

    test('empty input yields an empty map', () => {
      assert.equal(bestChunkPerPage([]).size, 0)
    })
  })

  describe('dedupeAndRank', () => {
    test('an equal-distance hop-1 match beats a hop-2-only match (penalty applied)', () => {
      const hop1 = [makeMatch({ pageId: 'direct', distance: 0.3 })]
      const hop2 = [makeMatch({ pageId: 'related', distance: 0.3 })]
      const ranked = dedupeAndRank(hop1, hop2)
      assert.deepEqual(
        ranked.map((r) => r.pageId),
        ['direct', 'related']
      )
      assert.equal(ranked[0]!.hop, 1)
      assert.equal(ranked[0]!.distance, 0.3)
      assert.equal(ranked[1]!.hop, 2)
      // -> The reported `distance` stays unpenalized; only sort order is.
      assert.equal(ranked[1]!.distance, 0.3)
    })

    test('a page in both hops reports hop: 1 with its real hop-1 distance, never hop-2-penalized', () => {
      const hop1 = [makeMatch({ pageId: 'both', distance: 0.4 })]
      const hop2 = [makeMatch({ pageId: 'both', distance: 0.05 })]
      const ranked = dedupeAndRank(hop1, hop2)
      assert.equal(ranked.length, 1)
      assert.equal(ranked[0]!.hop, 1)
      assert.equal(ranked[0]!.distance, 0.4)
    })

    test('a closer hop-2-only page can still outrank a farther hop-1 page once penalized', () => {
      const hop1 = [makeMatch({ pageId: 'direct', distance: 0.5 })]
      const hop2 = [makeMatch({ pageId: 'related', distance: 0.1 })]
      const ranked = dedupeAndRank(hop1, hop2)
      // 0.1 + HOP2_DISTANCE_PENALTY is still under 0.5
      assert.deepEqual(
        ranked.map((r) => r.pageId),
        ['related', 'direct']
      )
      assert.equal(ranked[0]!.distance, 0.1)
    })

    test('the penalty is exactly HOP2_DISTANCE_PENALTY, not a hardcoded value', () => {
      const hop1: SemanticChunkMatch[] = []
      const hop2 = [
        makeMatch({ pageId: 'a', distance: 0.2 }),
        makeMatch({ pageId: 'b', distance: 0.2 + HOP2_DISTANCE_PENALTY + 0.01 })
      ]
      const ranked = dedupeAndRank(hop1, hop2)
      assert.deepEqual(
        ranked.map((r) => r.pageId),
        ['a', 'b']
      )
    })

    test('dedupes a page appearing multiple times within the same hop to its best chunk', () => {
      const hop1 = [
        makeMatch({ pageId: 'a', chunkIndex: 0, distance: 0.6 }),
        makeMatch({ pageId: 'a', chunkIndex: 2, distance: 0.15 })
      ]
      const ranked = dedupeAndRank(hop1, [])
      assert.equal(ranked.length, 1)
      assert.equal(ranked[0]!.chunkIndex, 2)
      assert.equal(ranked[0]!.distance, 0.15)
    })

    test('empty hop-1 and hop-2 input yields an empty ranked list', () => {
      assert.deepEqual(dedupeAndRank([], []), [])
    })

    test('carries the shaping fields a SearchResult-like consumer needs', () => {
      const hop1 = [
        makeMatch({
          pageId: 'p1',
          path: '/foo/bar',
          locale: 'fr',
          title: 'Foo Bar',
          description: 'a page',
          icon: 'mdi:file',
          chunkText: 'the matched passage',
          chunkIndex: 3,
          distance: 0.12
        })
      ]
      const [result] = dedupeAndRank(hop1, [])
      assert.deepEqual(result, {
        pageId: 'p1',
        path: '/foo/bar',
        locale: 'fr',
        title: 'Foo Bar',
        description: 'a page',
        icon: 'mdi:file',
        chunkText: 'the matched passage',
        chunkIndex: 3,
        distance: 0.12,
        hop: 1
      })
    })
  })

  describe('mergeHopResults', () => {
    function outcome(scanned: SemanticChunkMatch[], visible: SemanticChunkMatch[]) {
      return { scanned, visible }
    }

    test('applies offset/limit to the merged, ranked, deduped list', () => {
      const hop1Visible = [
        makeMatch({ pageId: 'a', distance: 0.1 }),
        makeMatch({ pageId: 'b', distance: 0.2 }),
        makeMatch({ pageId: 'c', distance: 0.3 })
      ]
      const result = mergeHopResults(outcome(hop1Visible, hop1Visible), outcome([], []), {
        offset: 1,
        limit: 1
      })
      assert.equal(result.results.length, 1)
      assert.equal(result.results[0]!.pageId, 'b')
    })

    test('totalHits is the deduped page count, not the raw chunk-row count', () => {
      const hop1Visible = [
        makeMatch({ pageId: 'a', chunkIndex: 0, distance: 0.1 }),
        makeMatch({ pageId: 'a', chunkIndex: 1, distance: 0.2 }),
        makeMatch({ pageId: 'b', distance: 0.3 })
      ]
      const result = mergeHopResults(outcome(hop1Visible, hop1Visible), outcome([], []), {
        offset: 0,
        limit: 10
      })
      assert.equal(result.totalHits, 2)
    })

    test('totalHitsApproximate is false when nothing scanned was filtered out, at either hop', () => {
      const rows = [makeMatch({ pageId: 'a', distance: 0.1 })]
      const result = mergeHopResults(outcome(rows, rows), outcome(rows, rows), {
        offset: 0,
        limit: 10
      })
      assert.equal(result.totalHitsApproximate, false)
    })

    test('totalHitsApproximate is true when hop 1 scanned more than survived filterVisible', () => {
      const scanned = [
        makeMatch({ pageId: 'a', distance: 0.1 }),
        makeMatch({ pageId: 'hidden', distance: 0.2 })
      ]
      const visible = [scanned[0]!]
      const result = mergeHopResults(outcome(scanned, visible), outcome([], []), {
        offset: 0,
        limit: 10
      })
      assert.equal(result.totalHitsApproximate, true)
    })

    test('totalHitsApproximate is true when hop 2 scanned more than survived filterVisible', () => {
      const scanned = [
        makeMatch({ pageId: 'a', distance: 0.1 }),
        makeMatch({ pageId: 'hidden', distance: 0.2 })
      ]
      const visible = [scanned[0]!]
      const result = mergeHopResults(outcome([], []), outcome(scanned, visible), {
        offset: 0,
        limit: 10
      })
      assert.equal(result.totalHitsApproximate, true)
    })

    test('suggestion is always null, matching toSearchPagesResult', () => {
      const result = mergeHopResults(outcome([], []), outcome([], []), { offset: 0, limit: 10 })
      assert.equal(result.suggestion, null)
      assert.deepEqual(result.results, [])
      assert.equal(result.totalHits, 0)
    })
  })

  describe('search', () => {
    test('degrades to an empty, non-approximate result set when the local embedding model is unavailable', async () => {
      // -> Renaming `@huggingface/transformers` out of the way forces `embedText`'s real "unusable
      //    on this platform" path offline, rather than attempting the model's real download.
      const nodeModulesDir = path.join(import.meta.dirname, '..', 'node_modules', '@huggingface')
      const packageDir = path.join(nodeModulesDir, 'transformers')
      const disabledDir = path.join(nodeModulesDir, '.transformers-disabled-for-test')

      let wasRenamed = false
      try {
        await fs.rename(packageDir, disabledDir)
        wasRenamed = true
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          throw err
        }
      }

      const wikiHandle = installTestWiki({
        models: { extensions: { noteLoadFailure: mock.fn() } }
      })

      try {
        const result = await search('anything', undefined, 'site-1', ['en'], {
          limit: 10,
          offset: 0
        })
        assert.deepEqual(result, {
          results: [],
          totalHits: 0,
          totalHitsApproximate: false,
          suggestion: null
        })
      } finally {
        wikiHandle.restore()
        if (wasRenamed) {
          await fs.rename(disabledDir, packageDir)
        }
      }
    })
  })
})

/**
 * `pageEmbeddingChunks` is not part of the generated schema — `core/pgvectorBootstrap.ts` creates
 * it at boot — so this suite stands up its own copy of that shape in the fixture's schema, dropped
 * with it by `teardownTestDb()`. Its `vector(DIMS)` width is the real `EMBEDDING_DIMENSIONS`
 * (`helpers/embeddings.ts`), not an arbitrary small one; `basisVector`/`pad` keep that workable.
 */
describe('semanticSearch (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let groupsModel: typeof import('./groups.ts').groups
  let actor: PageActor
  let pgvectorAvailable = false

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ groups: groupsModel } = await import('./groups.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }

    pgvectorAvailable = await ensurePgvectorExtension()
    if (pgvectorAvailable) {
      await fixtures.db.execute(
        sql.raw(`
          CREATE TABLE "pageEmbeddingChunks" (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            "pageId" uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
            "chunkIndex" integer NOT NULL,
            "chunkText" text NOT NULL,
            embedding vector(${DIMS}) NOT NULL,
            "updatedAt" timestamptz NOT NULL DEFAULT now()
          )
        `)
      )
    }
  })

  after(async () => {
    await teardownTestDb()
  })

  /**
   * Postgres extensions are database-wide and `node --test` runs files concurrently against one
   * `DATABASE_URL`, so the advisory lock is what keeps two suites' `CREATE EXTENSION` from racing
   * — under its own key, so it never contends with `test/db.ts`'s `createExtensionsSerialized`.
   * Answers `false` rather than throwing when pgvector simply isn't installed, so the suite skips
   * instead of failing on an environment precondition.
   */
  async function ensurePgvectorExtension(): Promise<boolean> {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    const client = await pool.connect()
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext('wiki_test_extensions_vector'))`)
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public')
        return true
      } catch {
        return false
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext('wiki_test_extensions_vector'))`)
      }
    } finally {
      client.release()
      await pool.end()
    }
  }

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'getting-started',
      title: 'Getting Started',
      editor: 'markdown',
      content: '# Hello\n\nSome content.',
      ...overrides
    }
  }

  async function insertChunk(
    pageId: string,
    embedding: number[],
    overrides: { chunkIndex?: number; chunkText?: string } = {}
  ) {
    await fixtures.db.execute(sql`
      INSERT INTO "pageEmbeddingChunks" ("pageId", "chunkIndex", "chunkText", embedding)
      VALUES (
        ${pageId},
        ${overrides.chunkIndex ?? 0},
        ${overrides.chunkText ?? 'chunk text'},
        ${toVectorLiteral(embedding)}::vector
      )
    `)
  }

  async function restrictReaderToOpenBranch(): Promise<PageActor> {
    const rules: GroupRule[] = [
      {
        id: randomUUID(),
        name: 'allow everything by default',
        roles: ['read:pages'],
        match: 'START',
        mode: 'ALLOW',
        path: '',
        locales: [],
        sites: []
      },
      {
        id: randomUUID(),
        name: 'deny the hidden branch',
        roles: ['read:pages'],
        match: 'START',
        mode: 'DENY',
        path: 'docs/hidden',
        locales: [],
        sites: []
      }
    ]
    await fixtures.db.update(groupsTable).set({ rules }).where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()
    return { id: fixtures.userId, groupIds: [fixtures.groupId], permissions: [] }
  }

  describe('annSearch', () => {
    test('a hidden page (denied by page rules) never comes back, even as the nearest match', async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      const openPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/visible-page', title: 'Visible Page' }),
        actor
      )
      const hiddenPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/hidden/secret-page', title: 'Secret Page' }),
        actor
      )

      // -> The hidden page's chunk is the CLOSER match (identical to the query vector), so this
      //    proves `filterVisible` drops it despite ranking first.
      await insertChunk(hiddenPage.id, basisVector(0), { chunkText: 'exact match, but hidden' })
      await insertChunk(openPage.id, pad([0.9, 0.1, 0]), { chunkText: 'close match, visible' })

      const readerActor = await restrictReaderToOpenBranch()
      const results = await annSearch(basisVector(0), {
        siteId: fixtures.siteId,
        locales: ['en'],
        actor: readerActor
      })

      assert.equal(results.length, 1)
      assert.equal(results[0]!.pageId, openPage.id)
      assert.equal(results[0]!.path, 'docs/open/visible-page')
    })

    test('no actor means no filtering: both visible and hidden chunks come back', async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      const openPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/no-actor-open', title: 'No Actor Open' }),
        actor
      )
      const hiddenPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/hidden/no-actor-hidden', title: 'No Actor Hidden' }),
        actor
      )
      await insertChunk(openPage.id, basisVector(0))
      await insertChunk(hiddenPage.id, pad([0.9, 0.1, 0]))

      const results = await annSearch(basisVector(0), { siteId: fixtures.siteId, locales: ['en'] })

      // -> The whole file shares one fixture, so this site/locale also carries what earlier tests
      //    inserted: narrow to this test's own two pages rather than assert the whole scanned set.
      const pageIds = results
        .map((r) => r.pageId)
        .filter((id) => id === openPage.id || id === hiddenPage.id)
        .sort()
      assert.deepEqual(pageIds, [openPage.id, hiddenPage.id].sort())
    })

    test('results are ordered nearest-first by cosine distance', async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      const near = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/near', title: 'Near' }),
        actor
      )
      const mid = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/mid', title: 'Mid' }),
        actor
      )
      const far = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/far', title: 'Far' }),
        actor
      )
      // -> Inserted out of distance order, so a pass proves postgres's `ORDER BY`, not insertion
      //    order.
      await insertChunk(far.id, basisVector(1))
      await insertChunk(near.id, basisVector(0))
      await insertChunk(mid.id, pad([0.7, 0.7, 0]))

      const results = await annSearch(basisVector(0), { siteId: fixtures.siteId, locales: ['en'] })
      const own = results.filter((r) => [near.id, mid.id, far.id].includes(r.pageId))

      assert.deepEqual(
        own.map((r) => r.pageId),
        [near.id, mid.id, far.id]
      )
      assert.ok(own[0]!.distance < own[1]!.distance)
      assert.ok(own[1]!.distance < own[2]!.distance)
    })

    test("scoped to siteId: another site's chunks never come back", async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      const [otherSite] = await fixtures.db
        .insert(sitesTable)
        .values({
          hostname: 'other-site.localhost',
          isEnabled: true,
          config: { locales: { primary: 'en', active: ['en'] } }
        })
        .returning()
      CARDINAL.sites[otherSite!.id] = otherSite! as SiteRow

      const homePage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/home-site', title: 'Home Site Page' }),
        actor
      )
      const otherPage = await pagesModel.createPage(
        otherSite!.id,
        pageInput({ path: 'docs/open/other-site', title: 'Other Site Page' }),
        actor
      )
      await insertChunk(homePage.id, basisVector(0))
      await insertChunk(otherPage.id, basisVector(0))

      const results = await annSearch(basisVector(0), { siteId: fixtures.siteId, locales: ['en'] })
      const own = results.filter((r) => r.pageId === homePage.id || r.pageId === otherPage.id)

      assert.deepEqual(
        own.map((r) => r.pageId),
        [homePage.id]
      )
    })

    test('scoped to locale: a translation in another locale never comes back', async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      const enPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/locale-scope', title: 'Locale Scope', locale: 'en' }),
        actor
      )
      const frPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/locale-scope', title: 'Portée de la langue', locale: 'fr' }),
        actor
      )
      await insertChunk(enPage.id, basisVector(0))
      await insertChunk(frPage.id, basisVector(0))

      const results = await annSearch(basisVector(0), { siteId: fixtures.siteId, locales: ['en'] })
      const own = results.filter((r) => r.pageId === enPage.id || r.pageId === frPage.id)

      assert.deepEqual(
        own.map((r) => r.pageId),
        [enPage.id]
      )
    })

    test('locales: several values are ORed together, a locale named by neither still never comes back', async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      const enPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/multi-locale', title: 'Multi Locale', locale: 'en' }),
        actor
      )
      const frPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/multi-locale', title: 'Langue Multiple', locale: 'fr' }),
        actor
      )
      await insertChunk(enPage.id, basisVector(0))
      await insertChunk(frPage.id, basisVector(0))

      const results = await annSearch(basisVector(0), {
        siteId: fixtures.siteId,
        locales: ['en', 'fr']
      })
      const own = results
        .filter((r) => r.pageId === enPage.id || r.pageId === frPage.id)
        .map((r) => r.pageId)
        .sort()

      assert.deepEqual(own, [enPage.id, frPage.id].sort())
    })

    test('path: only a page whose path starts with the filter comes back', async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      const inside = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/guides/inside', title: 'Inside Guides' }),
        actor
      )
      const outside = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/other/outside', title: 'Outside Guides' }),
        actor
      )
      await insertChunk(inside.id, basisVector(0))
      await insertChunk(outside.id, basisVector(0))

      const results = await annSearch(basisVector(0), {
        siteId: fixtures.siteId,
        locales: ['en'],
        path: 'docs/guides'
      })
      const own = results.filter((r) => r.pageId === inside.id || r.pageId === outside.id)

      assert.deepEqual(
        own.map((r) => r.pageId),
        [inside.id]
      )
    })

    test('tags: a page must carry every listed tag, not merely one of them', async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      const both = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/tags-both', title: 'Tags Both', tags: ['alpha', 'beta'] }),
        actor
      )
      const onlyOne = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/tags-one', title: 'Tags One', tags: ['alpha'] }),
        actor
      )
      await insertChunk(both.id, basisVector(0))
      await insertChunk(onlyOne.id, basisVector(0))

      const results = await annSearch(basisVector(0), {
        siteId: fixtures.siteId,
        locales: ['en'],
        tags: ['alpha', 'beta']
      })
      const own = results.filter((r) => r.pageId === both.id || r.pageId === onlyOne.id)

      assert.deepEqual(
        own.map((r) => r.pageId),
        [both.id]
      )
    })

    test('editor: only a page using the named editor comes back', async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      const markdownPage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/open/editor-markdown',
          title: 'Editor Markdown',
          editor: 'markdown'
        }),
        actor
      )
      const codePage = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/open/editor-code', title: 'Editor Code', editor: 'code' }),
        actor
      )
      await insertChunk(markdownPage.id, basisVector(0))
      await insertChunk(codePage.id, basisVector(0))

      const results = await annSearch(basisVector(0), {
        siteId: fixtures.siteId,
        locales: ['en'],
        editor: 'code'
      })
      const own = results.filter((r) => r.pageId === markdownPage.id || r.pageId === codePage.id)

      assert.deepEqual(
        own.map((r) => r.pageId),
        [codePage.id]
      )
    })

    test('publishState: only a page in the named state comes back', async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      const published = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/open/publish-published',
          title: 'Publish Published',
          publishState: 'published'
        }),
        actor
      )
      const draft = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: 'docs/open/publish-draft',
          title: 'Publish Draft',
          publishState: 'draft'
        }),
        actor
      )
      await insertChunk(published.id, basisVector(0))
      await insertChunk(draft.id, basisVector(0))

      const results = await annSearch(basisVector(0), {
        siteId: fixtures.siteId,
        locales: ['en'],
        publishState: 'published'
      })
      const own = results.filter((r) => r.pageId === published.id || r.pageId === draft.id)

      assert.deepEqual(
        own.map((r) => r.pageId),
        [published.id]
      )
    })

    test("SEMANTIC_SCAN_CAP is a named constant, matching shared.ts's SCAN_CAP naming convention", () => {
      assert.equal(SEMANTIC_SCAN_CAP, 50)
    })
  })

  describe('runHop2', () => {
    const hop2AllowAllRule: GroupRule = {
      id: 'allow-all',
      name: 'Allow all',
      roles: ['read:pages'],
      match: 'START',
      mode: 'ALLOW',
      path: '',
      locales: [],
      sites: []
    }

    test("hop 2 queries by the seed chunk's own embedding, not the original query, and drops hidden pages", async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      await fixtures.db
        .update(groupsTable)
        .set({
          rules: [
            hop2AllowAllRule,
            {
              id: 'deny-hidden',
              name: 'Deny hidden',
              roles: ['read:pages'],
              match: 'START',
              mode: 'DENY',
              path: 'hidden-hop2-page',
              locales: [],
              sites: []
            }
          ]
        })
        .where(eq(groupsTable.id, fixtures.groupId))
      await groupsModel.reloadCache()

      const seedVector = basisVector(10)
      const nearSeed = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'near-seed', title: 'Near Seed' }),
        actor
      )
      await insertChunk(nearSeed.id, seedVector)

      const farFromSeed = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'far-from-seed', title: 'Far From Seed' }),
        actor
      )
      await insertChunk(farFromSeed.id, basisVector(11)) // orthogonal to the seed: distance 1

      const hidden = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'hidden-hop2-page', title: 'Hidden Hop2 Page' }),
        actor
      )
      await insertChunk(hidden.id, seedVector) // distance 0 too: would outrank all if visible

      // -> The seed row's own `distance` (hop 1, against the ORIGINAL query) is deliberately far
      //    from 0: had `runHop2` queried by anything but the seed's own `embedding`, the near-seed
      //    page would not come back as the closest match.
      const seed = makeRow({
        pageId: 'seed-page-not-a-real-row',
        embedding: seedVector,
        distance: 0.9
      })

      const readerActor = { groupIds: [fixtures.groupId], permissions: [] }
      const results = await runHop2([seed], {
        siteId: fixtures.siteId,
        locales: ['en'],
        actor: readerActor
      })

      const pageIds = results.map((r) => r.pageId)
      assert.ok(
        pageIds.includes(nearSeed.id),
        'the page whose chunk matches the seed vector is present'
      )
      assert.equal(
        pageIds.includes(hidden.id),
        false,
        'a page denied read:pages never surfaces via hop 2'
      )

      const near = results.find((r) => r.pageId === nearSeed.id)!
      const far = results.find((r) => r.pageId === farFromSeed.id)!
      assert.ok(near.distance < 0.01, "distance is measured against the seed chunk's own embedding")
      assert.ok(
        near.distance < far.distance,
        'the page matching the seed vector outranks the orthogonal one'
      )
    })

    test('seeds only the top HOP2_SEED_COUNT distinct pages -- a 4th distinct page never seeds a query', async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      await fixtures.db
        .update(groupsTable)
        .set({ rules: [hop2AllowAllRule] })
        .where(eq(groupsTable.id, fixtures.groupId))
      await groupsModel.reloadCache()

      const target = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'multi-seed-target', title: 'Multi Seed Target' }),
        actor
      )
      await insertChunk(target.id, basisVector(20))

      const excludedTarget = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'excluded-seed-target', title: 'Excluded Seed Target' }),
        actor
      )
      await insertChunk(excludedTarget.id, basisVector(23))

      const hop1: SemanticChunkMatch[] = [
        makeRow({ pageId: 'p0', embedding: basisVector(20), distance: 0 }),
        makeRow({ pageId: 'p1', embedding: basisVector(21), distance: 0.1 }),
        makeRow({ pageId: 'p2', embedding: basisVector(22), distance: 0.2 }),
        // -> a 4th distinct page, excluded as a seed by HOP2_SEED_COUNT: its embedding matches
        //    `excludedTarget`'s own chunk, so it must never seed a query.
        makeRow({ pageId: 'p3', embedding: basisVector(23), distance: 0.3 })
      ]

      const readerActor = { groupIds: [fixtures.groupId], permissions: [] }
      const results = await runHop2(hop1, {
        siteId: fixtures.siteId,
        locales: ['en'],
        actor: readerActor
      })

      assert.ok(
        results.some((r) => r.pageId === target.id && r.distance < 0.01),
        'the top-3 seed at basisVector(20) found the page whose own chunk matches it'
      )

      // -> With so few chunks in the database, `excluded-seed-target` turns up in every seed's
      //    overfetched (`SEMANTIC_SCAN_CAP`) scan anyway, so absence is not the signal. What proves
      //    its vector never seeded a query is that its distance is never near 0 -- a seeded query
      //    would score its own matching chunk at ~0, as `target` scores above.
      const excludedAppearances = results.filter((r) => r.pageId === excludedTarget.id)
      assert.ok(
        excludedAppearances.every((r) => r.distance > 0.9),
        "excluded-seed-target's own matching vector (basisVector(23)) was never used as a hop-2 query -- it only ever appears as a distant match under the 3 real seed vectors, never near 0"
      )
    })

    test('a page excluded by a filter never reappears via hop-2 expansion', async (t) => {
      if (!pgvectorAvailable) {
        t.skip('pgvector extension not installed on this Postgres')
        return
      }

      await fixtures.db
        .update(groupsTable)
        .set({ rules: [hop2AllowAllRule] })
        .where(eq(groupsTable.id, fixtures.groupId))
      await groupsModel.reloadCache()

      const seedVector = basisVector(30)
      const excludedByEditor = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'hop2-filtered-out', title: 'Hop2 Filtered Out', editor: 'code' }),
        actor
      )
      // -> Identical to the seed vector, so absent the filter it would be hop 2's own nearest match.
      await insertChunk(excludedByEditor.id, seedVector)

      const seed = makeRow({
        pageId: 'seed-page-not-a-real-row',
        embedding: seedVector,
        distance: 0.1
      })

      const readerActor = { groupIds: [fixtures.groupId], permissions: [] }
      const results = await runHop2([seed], {
        siteId: fixtures.siteId,
        locales: ['en'],
        actor: readerActor,
        editor: 'markdown'
      })

      assert.equal(
        results.some((r) => r.pageId === excludedByEditor.id),
        false,
        "the editor='markdown' filter keeps the code-editor page out of hop 2's own results"
      )
    })
  })
})
