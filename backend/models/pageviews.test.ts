import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { pageviews as pageviewsTable } from '../db/schema.ts'
import { hashVisitor } from './pageviews.ts'
import type { PageActor } from './pages.ts'

/**
 * `hashVisitor` needs no database at all -- it's a pure function -- so it gets its own top-level
 * tests rather than living inside the DB-backed `describe` below.
 */
test('hashVisitor never returns the raw id, and is deterministic per input', () => {
  const a = hashVisitor('secret-key-id')
  const b = hashVisitor('secret-key-id')
  const c = hashVisitor('a-different-key-id')

  assert.equal(a, b, 'the same raw id should hash to the same visitor')
  assert.notEqual(a, c, 'two different raw ids should hash to two different visitors')
  assert.ok(!a.includes('secret-key-id'), 'the raw id must never appear in the stored hash')
})

/**
 * `record()`/`purgeExpired()` are genuine SQL orchestration -- the admin opt-out's no-op guarantee and
 * the retention purge's timestamp comparison are exactly the kind of thing a mock of the query builder
 * would mostly just re-describe rather than verify, per CLAUDE.md's testing guidance. Real Postgres it
 * is, gated the same way every other DB-backed suite in this repo is.
 */
describe('pageviews model', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pageviewsModel: typeof import('./pageviews.ts').pageviews
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor
  let pageId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pageviews: pageviewsModel } = await import('./pageviews.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'pageviews-test', title: 'Pageviews Test', editor: 'markdown', content: 'x' },
      actor
    )
    pageId = page.id
  })

  after(async () => {
    await teardownTestDb()
  })

  test('record() inserts a row with a hashed visitor id when tracking is enabled', async () => {
    WIKI.config.pageviews = { isEnabled: true }

    await pageviewsModel.record({
      siteId: fixtures.siteId,
      pageId,
      clientType: 'browser',
      visitorRawId: 'session-abc'
    })

    const rows = await fixtures.db
      .select()
      .from(pageviewsTable)
      .where(eq(pageviewsTable.pageId, pageId))
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.clientType, 'browser')
    assert.equal(rows[0]!.visitorHash, hashVisitor('session-abc'))
    assert.notEqual(rows[0]!.visitorHash, 'session-abc')
  })

  test('record() no-ops entirely -- no row inserted -- while tracking is disabled', async () => {
    WIKI.config.pageviews = { isEnabled: false }
    const before = await fixtures.db.$count(pageviewsTable, eq(pageviewsTable.pageId, pageId))

    await pageviewsModel.record({
      siteId: fixtures.siteId,
      pageId,
      clientType: 'api',
      visitorRawId: 'some-api-key-id'
    })

    const after = await fixtures.db.$count(pageviewsTable, eq(pageviewsTable.pageId, pageId))
    assert.equal(after, before, 'no row should be inserted while the opt-out is on')
  })

  test('record() never throws when the insert itself fails', async () => {
    WIKI.config.pageviews = { isEnabled: true }

    // -> A page that does not exist trips the `pageId` foreign key -- record() must swallow that,
    //    not propagate it, since a logging failure must never break serving the page it rides along
    //    with.
    await assert.doesNotReject(
      pageviewsModel.record({
        siteId: fixtures.siteId,
        pageId: '00000000-0000-0000-0000-000000000000',
        clientType: 'mcp',
        visitorRawId: 'whatever'
      })
    )
  })

  test('purgeExpired removes rows past the 2-year retention window and keeps recent ones', async () => {
    await fixtures.db.insert(pageviewsTable).values([
      {
        siteId: fixtures.siteId,
        pageId,
        clientType: 'mcp',
        visitorHash: hashVisitor('old-visitor'),
        viewedAt: sql`now() - interval '3 years'`
      },
      {
        siteId: fixtures.siteId,
        pageId,
        clientType: 'mcp',
        visitorHash: hashVisitor('recent-visitor'),
        viewedAt: sql`now() - interval '1 day'`
      }
    ] as any)

    await pageviewsModel.purgeExpired()

    const remaining = await fixtures.db
      .select({ visitorHash: pageviewsTable.visitorHash })
      .from(pageviewsTable)
      .where(eq(pageviewsTable.pageId, pageId))
    const hashes = remaining.map((r) => r.visitorHash)
    assert.ok(!hashes.includes(hashVisitor('old-visitor')), 'a 3-year-old row should be purged')
    assert.ok(hashes.includes(hashVisitor('recent-visitor')), 'a 1-day-old row should survive')
  })
})
