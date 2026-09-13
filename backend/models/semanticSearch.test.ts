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

/**
 * `toVectorLiteral` is pure — no `WIKI`, no database — so it gets its own always-on describe rather
 * than living only inside the DB-backed section below (see "Testing (backend)" in CLAUDE.md).
 */
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
 * A `DIMS`-dim basis vector: `1` at `index`, `0` elsewhere. Two different indices are orthogonal
 * (cosine distance `1`); the same index is identical (cosine distance `0`) — exact, easy-to-reason-
 * about distances with no need for a real embedding model.
 */
function basisVector(index: number): number[] {
  const v = Array.from({ length: DIMS }, () => 0)
  v[index] = 1
  return v
}

/** Zero-pads a short, human-readable literal (e.g. `[0.9, 0.1, 0]`) out to `DIMS` dimensions.
 *  Cosine distance depends only on the coordinates that are non-zero in either operand, so padding
 *  both the query and every stored vector with trailing zeros leaves every distance in this file
 *  unchanged from what the same literal would produce in a smaller-dimension table — it just lets
 *  every hop-1 and hop-2 test in this file share one `vector(DIMS)` column. */
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

/**
 * `selectHop2Seeds` is pure — no `WIKI`, no database — same reasoning as `toVectorLiteral` above.
 */
describe('semanticSearch: selectHop2Seeds', () => {
  test("picks the top HOP2_SEED_COUNT distinct pages by each page's own best (lowest-distance) chunk", () => {
    const rows: SemanticChunkMatch[] = [
      makeRow({ pageId: 'page-a', chunkIndex: 0, distance: 0.5 }),
      makeRow({ pageId: 'page-a', chunkIndex: 1, distance: 0.1 }), // page-a's best chunk
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

/**
 * `bestChunkPerPage`, `dedupeAndRank`, `mergeHopResults` and `search`'s degradation path are pure or
 * near-pure (no database; `search`'s only external dependency is `helpers/embeddings.ts#embedText`) —
 * see "Prefer pure unit tests..." in CLAUDE.md.
 */
describe('semanticSearch: merge/rank/paginate', () => {
  /**
   * Canned fixture builder — a chunk match with only the fields a given test cares about spelled out,
   * everything else defaulted so a test reads as "what distinguishes this row from its siblings".
   */
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
      // -> The reported `distance` stays the real, unpenalized value — only sort order is penalized.
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
      // 0.1 + HOP2_DISTANCE_PENALTY (0.1) = 0.2, still less than 0.5
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
      // -> Forces `embedText`'s real "unusable on this platform" path the same way
      //    `helpers/embeddings.test.ts` does — renaming `@xenova/transformers` out of the way for the
      //    duration of this test — rather than actually attempting the real model's ~90MB download,
      //    so this exercises `search()`'s own degradation path fast and offline.
      const nodeModulesDir = path.join(import.meta.dirname, '..', 'node_modules', '@xenova')
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
        const result = await search('anything', undefined, 'site-1', 'en', { limit: 10, offset: 0 })
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
 * `annSearch` and `runHop2` are real SQL orchestration — a vector-index `ORDER BY`/`LIMIT` joined to
 * `pages` and filtered through `filterVisible` — the kind of thing this codebase's testing policy
 * reaches for a real Postgres over mocking the query builder for (see "Prefer pure unit tests..." in
 * CLAUDE.md).
 *
 * `pageEmbeddingChunks` is not part of the generated schema (see `semanticSearch.ts`'s own doc
 * comment) — `core/db.ts`'s real boot-time bootstrap (#3095) is what creates it against a live
 * instance. This suite stands up its own throwaway copy of that same shape directly against the
 * fixture's own schema, scoped to this file's test run and dropped with it in `teardownTestDb()`,
 * rather than depending on #3095 having merged.
 *
 * One `setupTestDb()`/`teardownTestDb()` pair for the whole DB-backed section, shared by both the
 * `annSearch` and `runHop2` describes below (see "Testing (backend)" in CLAUDE.md) — and one
 * `vector(DIMS)` table both hop 1 and hop 2 read and write, at the real `EMBEDDING_DIMENSIONS`
 * (`helpers/embeddings.ts`) rather than an arbitrary small width, via the `basisVector`/`pad` helpers
 * above.
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
   * Postgres extensions are database-wide, and `node --test` runs matched files concurrently against
   * the same `DATABASE_URL` — a session-scoped advisory lock (mirroring `test/db.ts`'s own
   * `createExtensionsSerialized`, under a distinct lock key so the two never contend with each other)
   * is what keeps two suites' `CREATE EXTENSION IF NOT EXISTS vector` from racing. Returns `false`
   * rather than throwing when the extension genuinely isn't installed on this Postgres, so the suite
   * can skip cleanly instead of failing on an environment precondition (per the design doc's own
   * "graceful degradation" testing note).
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

  /** Denies `read:pages` under `docs/hidden`, allows everything else — the same shape
   *  `modules/search/db/search.test.ts`'s "paging stability for a restricted reader" describe uses. */
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

      // -> The hidden page's chunk is the CLOSER match (identical to the query vector) -- proving
      //    `filterVisible` drops it despite ranking first, not merely that a farther visible row still
      //    shows up.
      await insertChunk(hiddenPage.id, basisVector(0), { chunkText: 'exact match, but hidden' })
      await insertChunk(openPage.id, pad([0.9, 0.1, 0]), { chunkText: 'close match, visible' })

      const readerActor = await restrictReaderToOpenBranch()
      const results = await annSearch(basisVector(0), {
        siteId: fixtures.siteId,
        locale: 'en',
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

      const results = await annSearch(basisVector(0), { siteId: fixtures.siteId, locale: 'en' })

      // -> One `setupTestDb()` fixture is shared by every test in this file (per the "Testing
      //    (backend)" convention), so the site/locale this suite scopes to also carries whatever
      //    earlier tests in this file inserted -- narrow down to this test's own two pages before
      //    asserting, rather than asserting the whole scanned set.
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
      // -> Inserted out of distance order, so a passing result proves postgres's own `ORDER BY`, not
      //    insertion order.
      await insertChunk(far.id, basisVector(1))
      await insertChunk(near.id, basisVector(0))
      await insertChunk(mid.id, pad([0.7, 0.7, 0]))

      const results = await annSearch(basisVector(0), { siteId: fixtures.siteId, locale: 'en' })
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
        .returning({ id: sitesTable.id })
      WIKI.sites[otherSite!.id] = {
        id: otherSite!.id,
        config: { locales: { primary: 'en', active: ['en'] } }
      }

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

      const results = await annSearch(basisVector(0), { siteId: fixtures.siteId, locale: 'en' })
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

      const results = await annSearch(basisVector(0), { siteId: fixtures.siteId, locale: 'en' })
      const own = results.filter((r) => r.pageId === enPage.id || r.pageId === frPage.id)

      assert.deepEqual(
        own.map((r) => r.pageId),
        [enPage.id]
      )
    })

    test("SEMANTIC_SCAN_CAP is a named constant, matching shared.ts's SCAN_CAP naming convention", () => {
      assert.equal(SEMANTIC_SCAN_CAP, 50)
    })
  })

  /**
   * Task #3100: hop-2 seed selection (pure, above) + the second ANN query (DB-backed here, real
   * pgvector and real page rules) — see
   * `docs/superpowers/specs/2026-09-13-semantic-vector-search-design.md`'s "Multi-hop retrieval
   * algorithm" section, steps 4-5.
   */
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
      await insertChunk(nearSeed.id, seedVector) // distance 0 to the seed vector

      const farFromSeed = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'far-from-seed', title: 'Far From Seed' }),
        actor
      )
      await insertChunk(farFromSeed.id, basisVector(11)) // orthogonal to the seed vector: distance 1

      const hidden = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'hidden-hop2-page', title: 'Hidden Hop2 Page' }),
        actor
      )
      await insertChunk(hidden.id, seedVector) // distance 0 too -- would outrank everything if visible

      // -> The seed row's own `distance` (from hop 1, against the ORIGINAL query) is deliberately set
      //    far from 0: if `runHop2` mistakenly reused it, or reused some other vector, instead of the
      //    seed's own `embedding`, the near-seed page would not come back as the closest match.
      const seed = makeRow({
        pageId: 'seed-page-not-a-real-row',
        embedding: seedVector,
        distance: 0.9
      })

      const readerActor = { groupIds: [fixtures.groupId], permissions: [] }
      const results = await runHop2([seed], {
        siteId: fixtures.siteId,
        locale: 'en',
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
        // -> a 4th distinct page, excluded as a seed by HOP2_SEED_COUNT -- its embedding
        //    (basisVector(23), matching excludedTarget's own chunk) must never seed a query.
        makeRow({ pageId: 'p3', embedding: basisVector(23), distance: 0.3 })
      ]

      const readerActor = { groupIds: [fixtures.groupId], permissions: [] }
      const results = await runHop2(hop1, {
        siteId: fixtures.siteId,
        locale: 'en',
        actor: readerActor
      })

      assert.ok(
        results.some((r) => r.pageId === target.id && r.distance < 0.01),
        'the top-3 seed at basisVector(20) found the page whose own chunk matches it'
      )

      // -> With only a handful of chunks in the whole test database, `excluded-seed-target` still
      //    turns up in every seed's own overfetched (`SEMANTIC_SCAN_CAP`) scan -- absence is not the
      //    right signal. What proves basisVector(23) was never USED AS A QUERY is that its distance
      //    is never near 0: if it had seeded a query, its own matching chunk would score ~0 against
      //    it, exactly like `target` does above against basisVector(20).
      const excludedAppearances = results.filter((r) => r.pageId === excludedTarget.id)
      assert.ok(
        excludedAppearances.every((r) => r.distance > 0.9),
        "excluded-seed-target's own matching vector (basisVector(23)) was never used as a hop-2 query -- it only ever appears as a distant match under the 3 real seed vectors, never near 0"
      )
    })
  })
})
