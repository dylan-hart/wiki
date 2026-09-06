import assert from 'node:assert/strict'
import { after, before, describe, mock, test } from 'node:test'
import crypto from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { pageviews as pageviewsTable } from '../db/schema.ts'
import { hashVisitor, pageviews } from './pageviews.ts'
import type { PageActor } from './pages.ts'

// `Settings.init()` -> `generateSigningCertificates()` calls `Temporal.Now.instant()` unconditionally,
// and `summary()` below calls `Date.prototype.toTemporalInstant()` -- `ensureTemporal()` installs both
// the `Temporal` global and that Date method, not just the former (see its own doc comment).
await ensureTemporal()

/** A fixed test key so DB-backed tests below get deterministic, reproducible hashes. */
const TEST_HASH_KEY = 'test-hash-key-0123456789abcdef'

/**
 * `hashVisitor` needs no database at all -- it's a pure function -- so it gets its own top-level
 * tests rather than living inside the DB-backed `describe` below.
 */
test('hashVisitor never returns the raw id, and is deterministic per input under one key', () => {
  const a = hashVisitor('secret-key-id', TEST_HASH_KEY)
  const b = hashVisitor('secret-key-id', TEST_HASH_KEY)
  const c = hashVisitor('a-different-key-id', TEST_HASH_KEY)

  assert.equal(a, b, 'the same raw id under the same key should hash to the same visitor')
  assert.notEqual(a, c, 'two different raw ids should hash to two different visitors')
  assert.ok(!a.includes('secret-key-id'), 'the raw id must never appear in the stored hash')
})

test('hashVisitor differs from a bare unkeyed sha256 digest of the same input', () => {
  const rawId = 'session-abc'
  const bareDigest = crypto.createHash('sha256').update(rawId).digest('hex')

  assert.notEqual(
    hashVisitor(rawId, TEST_HASH_KEY),
    bareDigest,
    'a keyed HMAC must not collapse to the same output as an unkeyed digest -- otherwise the key is decorative'
  )
})

test('hashVisitor produces different output for the same raw id under two different keys', () => {
  const rawId = 'session-abc'
  const otherKey = 'a-completely-different-key-fedcba9876'

  assert.notEqual(
    hashVisitor(rawId, TEST_HASH_KEY),
    hashVisitor(rawId, otherKey),
    'the same raw id must hash to unrelated outputs under two different keys, or the two are correlatable'
  )
})

/**
 * `Settings.init()` is what seeds `pageviews.hashKey` at first boot (mirroring `auth.secret`) --
 * verified here as a pure unit test the same way `hooks.test.ts` stubs `WIKI.db` rather than
 * standing up a real database, since what's under test is the JS-level shape of the seeded value,
 * not SQL orchestration.
 */
describe('Settings.init seeds pageviews.hashKey', () => {
  test('a fresh boot seeds a non-empty hashKey that is not shared with auth.secret', async () => {
    const inserted: { key: string; value: any }[] = []
    ;(globalThis as any).WIKI = {
      logger: { info: mock.fn(), warn: mock.fn(), debug: mock.fn() },
      version: 'test',
      releaseDate: 'test',
      db: {
        insert: () => ({
          values: (rows: { key: string; value: any }[]) => {
            inserted.push(...rows)
            return Promise.resolve()
          }
        })
      }
    }

    const { settings } = await import('./settings.ts')
    await settings.init({
      groupAdminId: 'group-admin',
      groupUserId: 'group-user',
      groupGuestId: 'group-guest',
      siteId: 'site-1',
      authModuleId: 'auth-module',
      userAdminId: 'user-admin',
      userGuestId: 'user-guest',
      classificationPublicId: 'classification-public',
      classificationInternalId: 'classification-internal',
      classificationRestrictedId: 'classification-restricted'
    } as any)

    const authRow = inserted.find((row) => row.key === 'auth')
    const pageviewsRow = inserted.find((row) => row.key === 'pageviews')

    assert.ok(pageviewsRow, 'a pageviews settings row must be seeded')
    assert.ok(
      typeof pageviewsRow!.value.hashKey === 'string' && pageviewsRow!.value.hashKey.length > 0,
      'pageviews.hashKey must be seeded non-empty'
    )
    assert.notEqual(
      pageviewsRow!.value.hashKey,
      authRow!.value.secret,
      'pageviews.hashKey must not be the same value as auth.secret'
    )
  })
})

/**
 * OpenProject #2288: rotating `pageviews.hashKey` so historical rows can no longer be re-linked.
 * Modelled on `models/sessions.ts#rotateSecret()` -- and, like that method's own test coverage, pure
 * config mutation plus a stubbed `WIKI.configSvc.saveToDb()`, no real database needed: what's under
 * test is the swap-and-persist-or-roll-back JS logic, not SQL orchestration.
 */
describe('rotateHashKey', () => {
  const previousWiki = (globalThis as any).WIKI

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('rotates the key, persists it, and makes the same raw id hash differently', async () => {
    const previousKey = 'pre-rotation-key'
    const saveToDb = mock.fn((_keys: string[]) => Promise.resolve(true))
    ;(globalThis as any).WIKI = {
      config: { pageviews: { isEnabled: true, hashKey: previousKey } },
      configSvc: { saveToDb },
      logger: { info: mock.fn(), warn: mock.fn() }
    }

    const rawId = 'some-session-id'
    const hashBeforeRotation = hashVisitor(rawId, previousKey)

    const rotated = await pageviews.rotateHashKey()

    assert.equal(rotated, true)
    assert.notEqual(WIKI.config.pageviews.hashKey, previousKey)
    assert.deepEqual(saveToDb.mock.calls[0]?.arguments[0], ['pageviews'])
    assert.notEqual(
      hashVisitor(rawId, WIKI.config.pageviews.hashKey),
      hashBeforeRotation,
      'the same raw id must hash differently once the key has rotated'
    )
  })

  test('restores the previous key and reports failure when the save fails', async () => {
    const previousConfig = { isEnabled: true, hashKey: 'pre-rotation-key' }
    ;(globalThis as any).WIKI = {
      config: { pageviews: { ...previousConfig } },
      configSvc: { saveToDb: mock.fn(() => Promise.resolve(false)) },
      logger: { info: mock.fn(), warn: mock.fn() }
    }

    const rotated = await pageviews.rotateHashKey()

    assert.equal(rotated, false)
    assert.deepEqual(
      WIKI.config.pageviews,
      previousConfig,
      'a failed save must leave the old key in place, not a half-rotated one'
    )
  })
})

/**
 * OpenProject #2269: `countsForGraph` reads the same `WIKI.config.pageviews.isEnabled` flag `record()`
 * already gates writes on. No database at all here -- the point is that the query never runs in the
 * first place, which a real Postgres round trip couldn't distinguish from "ran and found nothing".
 */
test('countsForGraph returns an empty map and never touches the database while pageview tracking is disabled', async () => {
  const previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = {
    config: { pageviews: { isEnabled: false } },
    db: new Proxy(
      {},
      {
        get() {
          throw new Error('must not touch the database while pageview tracking is disabled')
        }
      }
    )
  }
  try {
    const counts = await pageviews.countsForGraph('any-site-id')
    assert.deepEqual(counts, new Map())
  } finally {
    ;(globalThis as any).WIKI = previousWiki
  }
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
    WIKI.config.pageviews = { isEnabled: true, hashKey: TEST_HASH_KEY }

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
    assert.equal(rows[0]!.visitorHash, hashVisitor('session-abc', TEST_HASH_KEY))
    assert.notEqual(rows[0]!.visitorHash, 'session-abc')
  })

  test('record() no-ops entirely -- no row inserted -- while tracking is disabled', async () => {
    WIKI.config.pageviews = { isEnabled: false, hashKey: TEST_HASH_KEY }
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
    WIKI.config.pageviews = { isEnabled: true, hashKey: TEST_HASH_KEY }

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
        visitorHash: hashVisitor('old-visitor', TEST_HASH_KEY),
        viewedAt: sql`now() - interval '3 years'`
      },
      {
        siteId: fixtures.siteId,
        pageId,
        clientType: 'mcp',
        visitorHash: hashVisitor('recent-visitor', TEST_HASH_KEY),
        viewedAt: sql`now() - interval '1 day'`
      }
    ] as any)

    await pageviewsModel.purgeExpired()

    const remaining = await fixtures.db
      .select({ visitorHash: pageviewsTable.visitorHash })
      .from(pageviewsTable)
      .where(eq(pageviewsTable.pageId, pageId))
    const hashes = remaining.map((r) => r.visitorHash)
    assert.ok(
      !hashes.includes(hashVisitor('old-visitor', TEST_HASH_KEY)),
      'a 3-year-old row should be purged'
    )
    assert.ok(
      hashes.includes(hashVisitor('recent-visitor', TEST_HASH_KEY)),
      'a 1-day-old row should survive'
    )
  })

  describe('summary', () => {
    let summaryPageId: string
    let otherPageId: string
    // -> Earlier tests in this same DB-backed suite (record(), purgeExpired()) already left rows
    //    behind in this table, and `summary()` has no page/site filter -- it aggregates the WHOLE
    //    table by design. Asserting against a baseline captured right before this describe's own
    //    inserts, rather than hardcoded absolute counts, is what keeps these tests correct
    //    regardless of what earlier tests (or a re-ordered suite) left lying around.
    let baseline: Awaited<ReturnType<typeof pageviewsModel.summary>>

    before(async () => {
      baseline = await pageviewsModel.summary()

      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'pageviews-summary-test',
          title: 'Pageviews Summary Test',
          editor: 'markdown',
          content: 'x'
        },
        actor
      )
      summaryPageId = page.id
      const otherPage = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'pageviews-summary-other-test',
          title: 'Pageviews Summary Other Test',
          editor: 'markdown',
          content: 'x'
        },
        actor
      )
      otherPageId = otherPage.id

      await fixtures.db.insert(pageviewsTable).values([
        // -> Within the last 24h -- counts toward last24h, last7d and totalViews.
        {
          siteId: fixtures.siteId,
          pageId: summaryPageId,
          clientType: 'browser',
          visitorHash: hashVisitor('summary-visitor-1', TEST_HASH_KEY),
          viewedAt: sql`now() - interval '1 hour'`
        },
        // -> Within the last 7d but not the last 24h -- counts toward last7d and totalViews only.
        {
          siteId: fixtures.siteId,
          pageId: summaryPageId,
          clientType: 'api',
          visitorHash: hashVisitor('summary-visitor-2', TEST_HASH_KEY),
          viewedAt: sql`now() - interval '3 days'`
        },
        // -> Older than 7d but within retention -- counts toward totalViews only, and toward
        //    distinctPages via a second page.
        {
          siteId: fixtures.siteId,
          pageId: otherPageId,
          clientType: 'mcp',
          visitorHash: hashVisitor('summary-visitor-3', TEST_HASH_KEY),
          viewedAt: sql`now() - interval '30 days'`
        }
      ] as any)
    })

    test('aggregates totals across the retained window, distinct pages and the most recent view', async () => {
      const summary = await pageviewsModel.summary()

      assert.equal(summary.totalViews, baseline.totalViews + 3)
      assert.equal(summary.last24h, baseline.last24h + 1)
      assert.equal(summary.last7d, baseline.last7d + 2)
      assert.equal(summary.distinctPages, baseline.distinctPages + 2)
      assert.ok(summary.mostRecentAt, 'mostRecentAt must be set once rows exist')
      if (baseline.mostRecentAt) {
        assert.ok(
          Temporal.Instant.compare(
            Temporal.Instant.from(summary.mostRecentAt!),
            Temporal.Instant.from(baseline.mostRecentAt)
          ) >= 0,
          'mostRecentAt must never move backwards as new pageviews are recorded'
        )
      }
    })

    test('is not gated on WIKI.config.pageviews.isEnabled -- still reflects history while disabled', async () => {
      const previousConfig = WIKI.config.pageviews
      WIKI.config.pageviews = { isEnabled: false }
      try {
        const summary = await pageviewsModel.summary()
        assert.equal(
          summary.totalViews,
          baseline.totalViews + 3,
          'existing rows must still be counted while tracking is off'
        )
      } finally {
        WIKI.config.pageviews = previousConfig
      }
    })
  })

  describe('countsForGraph', () => {
    let countsPageId: string

    before(async () => {
      // -> countsForGraph now short-circuits on this flag itself (OpenProject #2269), not only
      //    `record()` -- explicit here rather than relying on whichever value an earlier sibling
      //    test in this file happened to leave it at.
      WIKI.config.pageviews = { isEnabled: true }

      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'pageviews-counts-test',
          title: 'Pageviews Counts Test',
          editor: 'markdown',
          content: 'x'
        },
        actor
      )
      countsPageId = page.id

      await fixtures.db.insert(pageviewsTable).values([
        // -> Two distinct browser visitors, one of whom came back within 30 days -- both count
        //    within 6mo/2yr, only one (the recent revisit) counts within 30d.
        {
          siteId: fixtures.siteId,
          pageId: countsPageId,
          clientType: 'browser',
          visitorHash: hashVisitor('graph-session-1', TEST_HASH_KEY),
          viewedAt: sql`now() - interval '5 days'`
        },
        {
          siteId: fixtures.siteId,
          pageId: countsPageId,
          clientType: 'browser',
          visitorHash: hashVisitor('graph-session-1', TEST_HASH_KEY),
          viewedAt: sql`now() - interval '1 day'`
        },
        {
          siteId: fixtures.siteId,
          pageId: countsPageId,
          clientType: 'browser',
          visitorHash: hashVisitor('graph-session-2', TEST_HASH_KEY),
          viewedAt: sql`now() - interval '3 months'`
        },
        // -> One `api` visitor, outside the 30d window but inside 6mo/2yr.
        {
          siteId: fixtures.siteId,
          pageId: countsPageId,
          clientType: 'api',
          visitorHash: hashVisitor('graph-api-key-1', TEST_HASH_KEY),
          viewedAt: sql`now() - interval '2 months'`
        },
        // -> One `mcp` visitor, outside every window but the 2yr one.
        {
          siteId: fixtures.siteId,
          pageId: countsPageId,
          clientType: 'mcp',
          visitorHash: hashVisitor('graph-mcp-key-1', TEST_HASH_KEY),
          viewedAt: sql`now() - interval '18 months'`
        }
      ] as any)
    })

    test('dedupes by visitorHash within each window and client type, and sums to "all"', async () => {
      const counts = await pageviewsModel.countsForGraph(fixtures.siteId)

      assert.deepEqual(counts.get(countsPageId), {
        last30d: {
          browser: 1,
          api: 0,
          mcp: 0,
          all: 1,
          // -> Both `graph-session-1` rows (5 days and 1 day ago) fall inside 30d -- raw total
          //    counts both, unlike the deduped `browser: 1` above.
          total: { browser: 2, api: 0, mcp: 0, all: 2 }
        },
        last6mo: {
          browser: 2,
          api: 1,
          mcp: 0,
          all: 3,
          total: { browser: 3, api: 1, mcp: 0, all: 4 }
        },
        last2yr: {
          browser: 2,
          api: 1,
          mcp: 1,
          all: 4,
          total: { browser: 3, api: 1, mcp: 1, all: 5 }
        }
      })
    })

    test('a page with no pageviews at all is simply absent from the map', async () => {
      const otherPage = await pagesModel.createPage(
        fixtures.siteId,
        { path: 'pageviews-counts-empty', title: 'No Views', editor: 'markdown', content: 'x' },
        actor
      )

      const counts = await pageviewsModel.countsForGraph(fixtures.siteId)

      assert.equal(counts.has(otherPage.id), false)
    })
  })
})
