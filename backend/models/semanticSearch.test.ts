import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { groups as groupsTable, pages as pagesTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { HOP2_SEED_COUNT, runHop2, selectHop2Seeds } from './semanticSearch.ts'
import type { SemanticChunkRow } from './semanticSearch.ts'
import type { GroupRule } from './groups.ts'

/**
 * Task #3100: hop-2 seed selection (pure) + the second ANN query (DB-backed, real pgvector and real
 * page rules) — see `docs/superpowers/specs/2026-09-13-semantic-vector-search-design.md`'s
 * "Multi-hop retrieval algorithm" section, steps 4-5.
 */

const DIMS = 384

/**
 * A 384-dim basis vector: `1` at `index`, `0` elsewhere. Two different indices are orthogonal
 * (cosine distance `1`); the same index is identical (cosine distance `0`) — exact, easy-to-reason-
 * about distances with no need for a real embedding model.
 */
function basisVector(index: number): number[] {
  const v = Array.from({ length: DIMS }, () => 0)
  v[index] = 1
  return v
}

function makeRow(overrides: Partial<SemanticChunkRow> = {}): SemanticChunkRow {
  return {
    chunkId: 'chunk-1',
    pageId: 'page-1',
    chunkText: 'irrelevant',
    embedding: basisVector(0),
    distance: 0,
    path: 'irrelevant',
    locale: 'en',
    tags: [],
    classification: null,
    ...overrides
  }
}

describe('semanticSearch.selectHop2Seeds (pure)', () => {
  test("picks the top HOP2_SEED_COUNT distinct pages by each page's own best (lowest-distance) chunk", () => {
    const rows: SemanticChunkRow[] = [
      makeRow({ chunkId: 'a1', pageId: 'page-a', distance: 0.5 }),
      makeRow({ chunkId: 'a2', pageId: 'page-a', distance: 0.1 }), // page-a's best chunk
      makeRow({ chunkId: 'b1', pageId: 'page-b', distance: 0.2 }),
      makeRow({ chunkId: 'c1', pageId: 'page-c', distance: 0.3 }),
      makeRow({ chunkId: 'd1', pageId: 'page-d', distance: 0.4 })
    ]

    const seeds = selectHop2Seeds(rows)

    assert.equal(seeds.length, HOP2_SEED_COUNT)
    assert.deepEqual(
      seeds.map((s) => [s.pageId, s.chunkId]),
      [
        ['page-a', 'a2'],
        ['page-b', 'b1'],
        ['page-c', 'c1']
      ]
    )
  })

  test('returns fewer than HOP2_SEED_COUNT seeds when hop 1 found fewer distinct pages', () => {
    const rows: SemanticChunkRow[] = [
      makeRow({ chunkId: 'a1', pageId: 'page-a', distance: 0.5 }),
      makeRow({ chunkId: 'a2', pageId: 'page-a', distance: 0.1 }),
      makeRow({ chunkId: 'b1', pageId: 'page-b', distance: 0.2 })
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
})

/**
 * DB-backed: real pgvector, real `pageEmbeddingChunks` rows, real page rules decided by
 * `WIKI.models.groups.checkAccess` through `filterVisible`.
 *
 * `core/pgvectorBootstrap.ts` (Task #3095) is not yet merged as of this task, so this suite creates
 * its own `pageEmbeddingChunks` table with the exact same DDL that task documents, rather than
 * importing a module that does not exist on this branch — see the epic-wide coordination note on
 * Task #3100 for why sibling tasks build against a documented shape instead of waiting on a merge.
 */
describe('semanticSearch.runHop2 (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pgvectorAvailable = false

  before(async () => {
    if (!hasTestDatabase()) {
      return
    }
    fixtures = await setupTestDb()

    const ext = await fixtures.db.execute(
      `SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`
    )
    pgvectorAvailable = ext.rows.length > 0
    if (!pgvectorAvailable) {
      return
    }

    await fixtures.db.execute('CREATE EXTENSION IF NOT EXISTS vector')
    await fixtures.db.execute(`
      CREATE TABLE IF NOT EXISTS "pageEmbeddingChunks" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "pageId" uuid NOT NULL REFERENCES "pages"("id") ON DELETE CASCADE,
        "chunkIndex" integer NOT NULL,
        "chunkText" text NOT NULL,
        "embedding" vector(384),
        "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
      )
    `)
  })

  after(async () => {
    if (!hasTestDatabase()) {
      return
    }
    await teardownTestDb()
  })

  /** Inserts a minimal, directly-queryable page row and returns its id. */
  async function insertPage(path: string): Promise<string> {
    const [row] = await fixtures.db
      .insert(pagesTable)
      .values({
        locale: 'en',
        path,
        hash: path,
        title: path,
        editor: 'markdown',
        contentType: 'markdown',
        authorId: fixtures.userId,
        creatorId: fixtures.userId,
        ownerId: fixtures.userId,
        siteId: fixtures.siteId,
        classification: fixtures.classificationId
      })
      .returning()
    return row!.id
  }

  async function insertChunk(
    pageId: string,
    chunkIndex: number,
    embedding: number[]
  ): Promise<void> {
    const vectorLiteral = `[${embedding.join(',')}]`
    await fixtures.db.execute(sql`
      INSERT INTO "pageEmbeddingChunks" ("pageId", "chunkIndex", "chunkText", "embedding")
      VALUES (${pageId}, ${chunkIndex}, 'irrelevant', ${vectorLiteral}::vector)
    `)
  }

  /** Writes `rules` onto the fixture group and reloads the in-memory cache from it, same pattern
   *  `groups.test.ts`'s own DB-backed `checkAccess` suite uses. */
  async function setGroupRules(rules: GroupRule[]): Promise<void> {
    await fixtures.db.update(groupsTable).set({ rules }).where(eq(groupsTable.id, fixtures.groupId))
    const { groups } = await import('./groups.ts')
    await groups.reloadCache()
  }

  const allowAllRule: GroupRule = {
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
      t.skip('pgvector extension is not installed on this Postgres server')
      return
    }

    await setGroupRules([
      allowAllRule,
      {
        id: 'deny-hidden',
        name: 'Deny hidden',
        roles: ['read:pages'],
        match: 'START',
        mode: 'DENY',
        path: 'hidden-page',
        locales: [],
        sites: []
      }
    ])

    const seedVector = basisVector(0)
    const nearSeedId = await insertPage('near-seed')
    await insertChunk(nearSeedId, 0, seedVector) // distance 0 to the seed vector

    const farFromSeedId = await insertPage('far-from-seed')
    await insertChunk(farFromSeedId, 0, basisVector(1)) // orthogonal to the seed vector: distance 1

    const hiddenId = await insertPage('hidden-page')
    await insertChunk(hiddenId, 0, seedVector) // distance 0 too -- would outrank everything if visible

    // -> The seed row's own `distance` (from hop 1, against the ORIGINAL query) is deliberately set
    //    far from 0: if `runHop2` mistakenly reused it, or reused some other vector, instead of the
    //    seed's own `embedding`, the near-seed page would not come back as the closest match.
    const seed = makeRow({
      chunkId: 'seed-chunk',
      pageId: 'seed-page',
      embedding: seedVector,
      distance: 0.9
    })

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    const results = await runHop2([seed], { siteId: fixtures.siteId, locale: 'en', actor })

    const pageIds = results.map((r) => r.pageId)
    assert.ok(
      pageIds.includes(nearSeedId),
      'the page whose chunk matches the seed vector is present'
    )
    assert.equal(
      pageIds.includes(hiddenId),
      false,
      'a page denied read:pages never surfaces via hop 2'
    )

    const near = results.find((r) => r.pageId === nearSeedId)!
    const far = results.find((r) => r.pageId === farFromSeedId)!
    assert.ok(near.distance < 0.01, "distance is measured against the seed chunk's own embedding")
    assert.ok(
      near.distance < far.distance,
      'the page matching the seed vector outranks the orthogonal one'
    )
  })

  test('seeds only the top HOP2_SEED_COUNT distinct pages -- a 4th distinct page never seeds a query', async (t) => {
    if (!pgvectorAvailable) {
      t.skip('pgvector extension is not installed on this Postgres server')
      return
    }

    await setGroupRules([allowAllRule])

    const targetId = await insertPage('multi-seed-target')
    await insertChunk(targetId, 0, basisVector(2))

    const excludedTargetId = await insertPage('excluded-seed-target')
    await insertChunk(excludedTargetId, 0, basisVector(5))

    const hop1: SemanticChunkRow[] = [
      makeRow({ chunkId: 's0', pageId: 'p0', embedding: basisVector(2), distance: 0 }),
      makeRow({ chunkId: 's1', pageId: 'p1', embedding: basisVector(3), distance: 0.1 }),
      makeRow({ chunkId: 's2', pageId: 'p2', embedding: basisVector(4), distance: 0.2 }),
      // -> a 4th distinct page, excluded as a seed by HOP2_SEED_COUNT -- its embedding
      //    (basisVector(5), matching excludedTargetId's own chunk) must never seed a query.
      makeRow({ chunkId: 's3', pageId: 'p3', embedding: basisVector(5), distance: 0.3 })
    ]

    const actor = { groupIds: [fixtures.groupId], permissions: [] }
    const results = await runHop2(hop1, { siteId: fixtures.siteId, locale: 'en', actor })

    assert.ok(
      results.some((r) => r.pageId === targetId && r.distance < 0.01),
      'the top-3 seed at basisVector(2) found the page whose own chunk matches it'
    )

    // -> With only a handful of chunks in the whole test database, `excluded-seed-target` still
    //    turns up in every seed's own overfetched (`SEMANTIC_SCAN_CAP`) scan -- absence is not the
    //    right signal. What proves basisVector(5) was never USED AS A QUERY is that its distance is
    //    never near 0: if it had seeded a query, its own matching chunk would score ~0 against it,
    //    exactly like `targetId` does above against basisVector(2).
    const excludedAppearances = results.filter((r) => r.pageId === excludedTargetId)
    assert.ok(
      excludedAppearances.every((r) => r.distance > 0.9),
      "excluded-seed-target's own matching vector (basisVector(5)) was never used as a hop-2 query -- it only ever appears as a distant match under the 3 real seed vectors, never near 0"
    )
  })
})
