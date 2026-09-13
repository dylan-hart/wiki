import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { groups as groupsTable, sites as sitesTable } from '../db/schema.ts'
import { SEMANTIC_SCAN_CAP, annSearch, toVectorLiteral } from './semanticSearch.ts'
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

/**
 * `annSearch` is real SQL orchestration — a vector-index `ORDER BY`/`LIMIT` joined to `pages` and
 * filtered through `filterVisible` — the kind of thing this codebase's testing policy reaches for a
 * real Postgres over mocking the query builder for (see "Prefer pure unit tests..." in CLAUDE.md).
 *
 * `pageEmbeddingChunks` is not part of the generated schema (see `semanticSearch.ts`'s own doc
 * comment) — `core/db.ts`'s real boot-time bootstrap (#3095) is what creates it against a live
 * instance. This suite stands up its own throwaway copy of that same shape directly against the
 * fixture's own schema, scoped to this file's test run and dropped with it in `teardownTestDb()`,
 * rather than depending on #3095 having merged — see the coordination note on this batch of Tasks.
 */
describe('semanticSearch: annSearch (DB-backed)', { skip: !hasTestDatabase() }, () => {
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
      // -> `vector(3)` rather than the real 384 dims: this suite is proving the query/filter
      //    plumbing, not the embedding model, and a tiny fixed dimension keeps every literal in this
      //    file readable by hand.
      await fixtures.db.execute(
        sql.raw(`
          CREATE TABLE "pageEmbeddingChunks" (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            "pageId" uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
            "chunkIndex" integer NOT NULL,
            "chunkText" text NOT NULL,
            embedding vector(3) NOT NULL,
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
    await insertChunk(hiddenPage.id, [1, 0, 0], { chunkText: 'exact match, but hidden' })
    await insertChunk(openPage.id, [0.9, 0.1, 0], { chunkText: 'close match, visible' })

    const readerActor = await restrictReaderToOpenBranch()
    const results = await annSearch([1, 0, 0], {
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
    await insertChunk(openPage.id, [1, 0, 0])
    await insertChunk(hiddenPage.id, [0.9, 0.1, 0])

    const results = await annSearch([1, 0, 0], { siteId: fixtures.siteId, locale: 'en' })

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
    await insertChunk(far.id, [0, 1, 0])
    await insertChunk(near.id, [1, 0, 0])
    await insertChunk(mid.id, [0.7, 0.7, 0])

    const results = await annSearch([1, 0, 0], { siteId: fixtures.siteId, locale: 'en' })
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
    await insertChunk(homePage.id, [1, 0, 0])
    await insertChunk(otherPage.id, [1, 0, 0])

    const results = await annSearch([1, 0, 0], { siteId: fixtures.siteId, locale: 'en' })
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
    await insertChunk(enPage.id, [1, 0, 0])
    await insertChunk(frPage.id, [1, 0, 0])

    const results = await annSearch([1, 0, 0], { siteId: fixtures.siteId, locale: 'en' })
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
