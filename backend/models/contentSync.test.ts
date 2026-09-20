import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import {
  assets as assetsTable,
  contentSyncState as contentSyncStateTable,
  pages as pagesTable,
  storage as storageTable
} from '../db/schema.ts'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import type { PageActor } from './pages.ts'
import { contentSync, type SyncContentType } from './contentSync.ts'
import { ensureTemporal } from '../test/temporal.ts'

/**
 * The fixture must stay `test/db.ts`'s fresh per-run migrated schema, never a hand-rolled `Pool`
 * against the target database's `public` schema: a drifted long-lived schema there (`lastSyncedAt`
 * left as a naive `timestamp`) reads back through postgres-date's process-`TZ` fallback and
 * silently breaks the timestamp assertions below.
 */
const DATABASE_URL = process.env.DATABASE_URL
const skip = DATABASE_URL
  ? false
  : 'requires DATABASE_URL (a Postgres instance with migrations applied)'

let fixtures: TestFixtures
let siteId: string
let userId: string
let pageTargetId: string
let otherTargetId: string
let classificationId: string

before(async () => {
  if (!DATABASE_URL) {
    return
  }
  await ensureTemporal()

  fixtures = await setupTestDb()
  await seedLocale(fixtures.db, { code: 'en' })
  siteId = fixtures.siteId
  userId = fixtures.userId
  classificationId = fixtures.classificationId

  const targets = await CARDINAL.db
    .insert(storageTable)
    .values([
      { siteId, module: 'test-git' },
      { siteId, module: 'test-s3' }
    ])
    .returning({ id: storageTable.id })
  pageTargetId = targets[0].id
  otherTargetId = targets[1].id
})

after(async () => {
  if (!DATABASE_URL) {
    return
  }
  await teardownTestDb()
})

async function makePage(path: string): Promise<string> {
  const [row] = await CARDINAL.db
    .insert(pagesTable)
    .values({
      siteId,
      locale: 'en',
      path,
      hash: path,
      title: path,
      editor: 'markdown',
      contentType: 'markdown',
      authorId: userId,
      creatorId: userId,
      ownerId: userId,
      classification: classificationId
    })
    .returning({ id: pagesTable.id })
  return row.id
}

async function makeAsset(fileName: string): Promise<string> {
  const [row] = await CARDINAL.db
    .insert(assetsTable)
    .values({ siteId, authorId: userId, fileName, fileExt: 'png' })
    .returning({ id: assetsTable.id })
  return row.id
}

/**
 * `recordSuccess` serialises `syncedAt` with `smallestUnit: 'millisecond'`, which TRUNCATES, while a
 * freshly inserted row's `updatedAt` is Postgres's own `now()` at microsecond precision — so a sync
 * "right after the insert" can land *before* it, leaving the row still out of date. Reading the DB
 * clock once and adding a whole second makes the ordering a fact, not a race.
 */
async function dbClock(): Promise<Temporal.Instant> {
  const [{ dbNow }] = (await CARDINAL.db.execute(sql`select now() as "dbNow"`)).rows as [
    { dbNow: string }
  ]
  return Temporal.Instant.from(dbNow)
}

async function syncedAfterInserts(): Promise<Temporal.Instant> {
  return (await dbClock()).add({ seconds: 1 })
}

/**
 * These read `contentSyncState` directly rather than through the model: a read method whose only
 * caller is its own test is a fixture, not model surface.
 */
type SyncStateRow = typeof contentSyncStateTable.$inferSelect

async function readState(
  contentType: SyncContentType,
  contentId: string,
  targetId: string
): Promise<SyncStateRow | null> {
  const rows = await CARDINAL.db
    .select()
    .from(contentSyncStateTable)
    .where(
      and(
        eq(contentSyncStateTable.contentType, contentType),
        eq(contentSyncStateTable.contentId, contentId),
        eq(contentSyncStateTable.targetId, targetId)
      )
    )
    .limit(1)
  return rows[0] ?? null
}

async function readStatesForContent(
  contentType: SyncContentType,
  contentId: string
): Promise<SyncStateRow[]> {
  return CARDINAL.db
    .select()
    .from(contentSyncStateTable)
    .where(
      and(
        eq(contentSyncStateTable.contentType, contentType),
        eq(contentSyncStateTable.contentId, contentId)
      )
    )
}

async function readStatesForTarget(targetId: string): Promise<SyncStateRow[]> {
  return CARDINAL.db
    .select()
    .from(contentSyncStateTable)
    .where(eq(contentSyncStateTable.targetId, targetId))
}

/** Its own target, so a count over it is not shared with any other test. */
async function makeTarget(module: string): Promise<string> {
  const [row] = await CARDINAL.db
    .insert(storageTable)
    .values({ siteId, module })
    .returning({ id: storageTable.id })
  return row.id
}

test('no row exists for a pairing that has never synced', { skip }, async () => {
  const pageId = await makePage('never-synced')
  const state = await readState('page', pageId, pageTargetId)
  assert.equal(state, null)
})

test('recordSuccess creates a row that reads back with every field set', { skip }, async () => {
  const pageId = await makePage('record-success')
  await contentSync.recordSuccess({
    contentType: 'page',
    contentId: pageId,
    targetId: pageTargetId,
    direction: 'push',
    targetRef: { commit: 'abc123' }
  })

  const state = await readState('page', pageId, pageTargetId)
  assert.ok(state)
  assert.equal(state!.lastDirection, 'push')
  assert.deepEqual(state!.targetRef, { commit: 'abc123' })
  assert.equal(state!.lastError, null)
  assert.ok(state!.lastSyncedAt instanceof Date)
})

test('recordSuccess upserts in place rather than creating a second row', { skip }, async () => {
  const pageId = await makePage('record-success-upsert')
  await contentSync.recordSuccess({
    contentType: 'page',
    contentId: pageId,
    targetId: pageTargetId,
    direction: 'push',
    targetRef: 'sha-1'
  })
  await contentSync.recordSuccess({
    contentType: 'page',
    contentId: pageId,
    targetId: pageTargetId,
    direction: 'pull',
    targetRef: 'sha-2'
  })

  const states = await readStatesForContent('page', pageId)
  assert.equal(states.length, 1)
  assert.equal(states[0].lastDirection, 'pull')
  assert.equal(states[0].targetRef, 'sha-2')
})

test(
  'recordFailure sets lastError without touching a prior successful sync',
  { skip },
  async () => {
    const pageId = await makePage('record-failure-after-success')
    await contentSync.recordSuccess({
      contentType: 'page',
      contentId: pageId,
      targetId: pageTargetId,
      direction: 'push',
      targetRef: 'sha-good'
    })
    const afterSuccess = await readState('page', pageId, pageTargetId)

    await contentSync.recordFailure({
      contentType: 'page',
      contentId: pageId,
      targetId: pageTargetId,
      error: 'connection reset'
    })
    const afterFailure = await readState('page', pageId, pageTargetId)

    assert.equal(afterFailure!.lastError, 'connection reset')
    assert.equal(afterFailure!.lastDirection, 'push')
    assert.equal(afterFailure!.targetRef, 'sha-good')
    assert.deepEqual(afterFailure!.lastSyncedAt, afterSuccess!.lastSyncedAt)
  }
)

test('recordSuccess files a row per target, each scoped to its own', { skip }, async () => {
  const pageId = await makePage('states-for-target')
  await contentSync.recordSuccess({
    contentType: 'page',
    contentId: pageId,
    targetId: pageTargetId,
    direction: 'push'
  })
  await contentSync.recordSuccess({
    contentType: 'page',
    contentId: pageId,
    targetId: otherTargetId,
    direction: 'push'
  })

  const states = await readStatesForTarget(pageTargetId)
  assert.ok(states.every((s) => s.targetId === pageTargetId))
  assert.ok(states.some((s) => s.contentId === pageId))
})

// ---------------------------------------------------------------------------------------------
// countOutOfDate -- asserted as a delta around one page: every test in this file shares one
// `siteId`, so the site's page/asset population only grows and no absolute count is stable.
// ---------------------------------------------------------------------------------------------

test('countOutOfDate counts a page that has never synced to the target', { skip }, async () => {
  const targetId = await makeTarget('test-count-never-synced')
  const before = await contentSync.countOutOfDate('page', targetId, { siteId })
  await makePage('never-synced-out-of-date')
  assert.equal(await contentSync.countOutOfDate('page', targetId, { siteId }), before + 1)
})

test('countOutOfDate drops a page synced after its last update', { skip }, async () => {
  const targetId = await makeTarget('test-count-synced')
  const pageId = await makePage('synced-up-to-date')
  const before = await contentSync.countOutOfDate('page', targetId, { siteId })
  await contentSync.recordSuccess({
    contentType: 'page',
    contentId: pageId,
    targetId,
    direction: 'push',
    syncedAt: await syncedAfterInserts()
  })

  assert.equal(await contentSync.countOutOfDate('page', targetId, { siteId }), before - 1)
})

test('countOutOfDate counts a page updated after its last sync again', { skip }, async () => {
  const targetId = await makeTarget('test-count-updated-after-sync')
  const pageId = await makePage('updated-after-sync')

  // -> Both timestamps come off one read of Postgres's own clock: `pages.updatedAt` is written by
  //    Postgres while `recordSuccess` stamps `lastSyncedAt` from the caller's instant, truncated to
  //    milliseconds. Sync at now + 1s, edit at now + 2s: the ordering holds at any timing.
  const dbNow = await dbClock()
  const editedAt = dbNow.add({ seconds: 2 })
  await contentSync.recordSuccess({
    contentType: 'page',
    contentId: pageId,
    targetId,
    direction: 'push',
    syncedAt: dbNow.add({ seconds: 1 })
  })
  const whileSynced = await contentSync.countOutOfDate('page', targetId, { siteId })
  await CARDINAL.db
    .update(pagesTable)
    .set({ title: 'edited after sync', updatedAt: new Date(editedAt.epochMilliseconds) })
    .where(eq(pagesTable.id, pageId))

  assert.equal(await contentSync.countOutOfDate('page', targetId, { siteId }), whileSynced + 1)
})

test('countOutOfDate applies the same logic to assets', { skip }, async () => {
  const targetId = await makeTarget('test-count-assets')
  const assetId = await makeAsset('never-synced.png')
  const before = await contentSync.countOutOfDate('asset', targetId, { siteId })
  assert.ok(before >= 1)

  await contentSync.recordSuccess({
    contentType: 'asset',
    contentId: assetId,
    targetId,
    direction: 'push',
    syncedAt: await syncedAfterInserts()
  })
  assert.equal(await contentSync.countOutOfDate('asset', targetId, { siteId }), before - 1)
})

test('countOutOfDate is scoped to its contentType, not just the target', { skip }, async () => {
  const targetId = await makeTarget('test-count-content-type-scope')
  const pageId = await makePage('count-type-scope')
  const pagesBefore = await contentSync.countOutOfDate('page', targetId, { siteId })
  const assetsBefore = await contentSync.countOutOfDate('asset', targetId, { siteId })

  await contentSync.recordSuccess({
    contentType: 'page',
    contentId: pageId,
    targetId,
    direction: 'push',
    syncedAt: await syncedAfterInserts()
  })
  await makeAsset('count-type-scope.png')

  assert.equal(await contentSync.countOutOfDate('page', targetId, { siteId }), pagesBefore - 1)
  assert.equal(await contentSync.countOutOfDate('asset', targetId, { siteId }), assetsBefore + 1)
})

test('getTargetSummary reports nothing for a target with no state at all', { skip }, async () => {
  const targets = await CARDINAL.db
    .insert(storageTable)
    .values({ siteId, module: 'test-summary-empty' })
    .returning({ id: storageTable.id })
  const summary = await contentSync.getTargetSummary(targets[0].id, { siteId })
  assert.equal(summary.lastSyncedAt, null)
  assert.equal(summary.lastError, null)
  assert.equal(summary.lastAttemptAt, null)
  // -> Not asserted as 0: tests share `siteId`, and a page left behind by another has never synced
  //    to this brand-new target either, which legitimately counts as out of date.
  assert.ok(summary.outOfDateCount >= 0)
})

test(
  'getTargetSummary reports the most recent success and out-of-date count',
  { skip },
  async () => {
    const targets = await CARDINAL.db
      .insert(storageTable)
      .values({ siteId, module: 'test-summary-synced' })
      .returning({ id: storageTable.id })
    const targetId = targets[0].id
    const syncedPageId = await makePage('summary-synced')
    await contentSync.recordSuccess({
      contentType: 'page',
      contentId: syncedPageId,
      targetId,
      direction: 'push'
    })
    // -> Never synced to this target, so it counts as out of date even with no error involved.
    await makePage('summary-out-of-date')

    const summary = await contentSync.getTargetSummary(targetId, { siteId })
    assert.ok(summary.lastSyncedAt)
    assert.equal(summary.lastError, null)
    assert.ok(summary.outOfDateCount >= 1)
  }
)

test(
  'getTargetSummary counts every page and asset for a target that has never synced',
  { skip },
  async () => {
    // -> A brand-new target has no `contentSyncState` rows at all, so every page and asset matches
    //    through the `isNull(lastSyncedAt)` disjunct -- the aggregate path, not a fetch-and-count.
    const targetId = await makeTarget('test-summary-never-synced')
    await makePage('never-synced-summary-page')
    await makeAsset('never-synced-summary-asset.png')

    const [summary, pageCount, assetCount] = await Promise.all([
      contentSync.getTargetSummary(targetId, { siteId }),
      CARDINAL.db.$count(pagesTable, eq(pagesTable.siteId, siteId)),
      CARDINAL.db.$count(assetsTable, eq(assetsTable.siteId, siteId))
    ])

    // -> No fixed number to assert against, since earlier tests share this `siteId` -- so the
    //    aggregate is cross-checked against a plain count of the site's own pages and assets.
    assert.equal(summary.outOfDateCount, pageCount + assetCount)
    assert.ok(summary.outOfDateCount >= 2)
  }
)

test('getTargetSummary surfaces the most recent error', { skip }, async () => {
  const targets = await CARDINAL.db
    .insert(storageTable)
    .values({ siteId, module: 'test-summary-error' })
    .returning({ id: storageTable.id })
  const targetId = targets[0].id
  const pageId = await makePage('summary-error')
  await contentSync.recordFailure({
    contentType: 'page',
    contentId: pageId,
    targetId,
    error: 'connection refused'
  })

  const summary = await contentSync.getTargetSummary(targetId, { siteId })
  assert.equal(summary.lastError, 'connection refused')
  assert.ok(summary.lastAttemptAt)
  assert.equal(summary.lastSyncedAt, null)
})

// ---------------------------------------------------------------------------------------------
// getTargetSummary: stale error suppression -- a per-item error that is never individually retried
// must not keep the target's status card showing "error" forever once other content has
// demonstrably synced successfully since.
// ---------------------------------------------------------------------------------------------

test(
  'getTargetSummary keeps surfacing an error with no later success on the target',
  { skip },
  async () => {
    const targets = await CARDINAL.db
      .insert(storageTable)
      .values({ siteId, module: 'test-summary-stale-none' })
      .returning({ id: storageTable.id })
    const targetId = targets[0].id
    const failedPageId = await makePage('stale-error-no-success')
    await contentSync.recordFailure({
      contentType: 'page',
      contentId: failedPageId,
      targetId,
      error: 'connection refused'
    })

    const summary = await contentSync.getTargetSummary(targetId, { siteId })
    assert.equal(summary.lastError, 'connection refused')
    assert.ok(summary.lastAttemptAt)
  }
)

test(
  "getTargetSummary hides a page's error once a *different* item has since synced successfully",
  { skip },
  async () => {
    const targets = await CARDINAL.db
      .insert(storageTable)
      .values({ siteId, module: 'test-summary-stale-cleared' })
      .returning({ id: storageTable.id })
    const targetId = targets[0].id

    const failedPageId = await makePage('stale-error-failed-item')
    await contentSync.recordFailure({
      contentType: 'page',
      contentId: failedPageId,
      targetId,
      error: 'connection refused'
    })
    // -> A later success on a DIFFERENT item: the failed row is never retried, so its own
    //    `lastError` stays set while the target as a whole has proven itself healthy. `syncedAt` is
    //    nudged two seconds ahead because the failure's `updatedAt` comes from postgres's own clock,
    //    not this process's.
    const succeededPageId = await makePage('stale-error-other-item')
    await contentSync.recordSuccess({
      contentType: 'page',
      contentId: succeededPageId,
      targetId,
      direction: 'push',
      syncedAt: Temporal.Now.instant().add({ seconds: 2 })
    })

    const summary = await contentSync.getTargetSummary(targetId, { siteId })
    assert.equal(summary.lastError, null)
    assert.equal(summary.lastAttemptAt, null)
    assert.ok(summary.lastSyncedAt)

    // -> The row itself is untouched -- only the target-level summary treats it as stale.
    const rawState = await readState('page', failedPageId, targetId)
    assert.equal(rawState!.lastError, 'connection refused')
  }
)

test(
  'getTargetSummary still surfaces a fresh error even after an earlier success on the target',
  { skip },
  async () => {
    const targets = await CARDINAL.db
      .insert(storageTable)
      .values({ siteId, module: 'test-summary-fresh-error' })
      .returning({ id: storageTable.id })
    const targetId = targets[0].id
    const pageId = await makePage('fresh-error-after-success')

    // -> `syncedAt` is pinned well into the past because this process's clock and postgres's own
    //    (which the following `recordFailure` writes through) need not agree to the millisecond;
    //    all this test cares about is that the success is unambiguously *before* the error.
    await contentSync.recordSuccess({
      contentType: 'page',
      contentId: pageId,
      targetId,
      direction: 'push',
      syncedAt: Temporal.Now.instant().subtract({ seconds: 5 })
    })
    await contentSync.recordFailure({
      contentType: 'page',
      contentId: pageId,
      targetId,
      error: 'disk full'
    })

    const summary = await contentSync.getTargetSummary(targetId, { siteId })
    assert.equal(summary.lastError, 'disk full')
    assert.ok(summary.lastAttemptAt)
  }
)

// ---------------------------------------------------------------------------------------------
// Non-UTC process TZ coverage -- `lastSyncedAt` is a `timestamptz` column, decoded by node-postgres
// from the wire-format offset it carries rather than reinterpreted through the Node process's local
// zone the way a naive `timestamp` column would be.
// ---------------------------------------------------------------------------------------------

test(
  'lastSyncedAt round-trips a known instant to the millisecond under a non-UTC process TZ',
  { skip },
  async () => {
    const originalTz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const targets = await CARDINAL.db
        .insert(storageTable)
        .values({ siteId, module: 'test-tz-roundtrip' })
        .returning({ id: storageTable.id })
      const targetId = targets[0].id
      const pageId = await makePage('tz-roundtrip')
      const instant = Temporal.Instant.from('2026-08-24T12:00:00.000Z')

      await contentSync.recordSuccess({
        contentType: 'page',
        contentId: pageId,
        targetId,
        direction: 'push',
        syncedAt: instant
      })

      const state = await readState('page', pageId, targetId)
      assert.equal(state!.lastSyncedAt!.getTime(), instant.epochMilliseconds)
    } finally {
      process.env.TZ = originalTz
    }
  }
)

async function runStaleCheck(
  tz: string,
  { successAfterFailure }: { successAfterFailure: boolean }
): Promise<{ lastError: string | null; lastAttemptAt: string | null }> {
  const originalTz = process.env.TZ
  process.env.TZ = tz
  try {
    const targets = await CARDINAL.db
      .insert(storageTable)
      .values({ siteId, module: `test-tz-stale-${tz}-${successAfterFailure}-${Date.now()}` })
      .returning({ id: storageTable.id })
    const targetId = targets[0].id
    const failedPageId = await makePage(`tz-stale-${tz}-${successAfterFailure}-failed`)

    if (successAfterFailure) {
      await contentSync.recordFailure({
        contentType: 'page',
        contentId: failedPageId,
        targetId,
        error: 'connection refused'
      })
      const succeededPageId = await makePage(`tz-stale-${tz}-${successAfterFailure}-succeeded`)
      await contentSync.recordSuccess({
        contentType: 'page',
        contentId: succeededPageId,
        targetId,
        direction: 'push',
        syncedAt: Temporal.Now.instant().add({ seconds: 2 })
      })
    } else {
      const succeededPageId = await makePage(`tz-stale-${tz}-${successAfterFailure}-succeeded`)
      await contentSync.recordSuccess({
        contentType: 'page',
        contentId: succeededPageId,
        targetId,
        direction: 'push',
        syncedAt: Temporal.Now.instant().subtract({ seconds: 5 })
      })
      await contentSync.recordFailure({
        contentType: 'page',
        contentId: failedPageId,
        targetId,
        error: 'connection refused'
      })
    }

    const summary = await contentSync.getTargetSummary(targetId, { siteId })
    return { lastError: summary.lastError, lastAttemptAt: summary.lastAttemptAt }
  } finally {
    process.env.TZ = originalTz
  }
}

test(
  'errorIsStale suppresses a stale error identically under UTC and a non-UTC process TZ',
  { skip },
  async () => {
    const utc = await runStaleCheck('UTC', { successAfterFailure: true })
    const nonUtc = await runStaleCheck('America/New_York', { successAfterFailure: true })
    assert.equal(utc.lastError, null)
    assert.deepEqual(nonUtc, utc)
  }
)

test(
  'errorIsStale keeps surfacing a fresh error identically under UTC and a non-UTC process TZ',
  { skip },
  async () => {
    const utc = await runStaleCheck('UTC', { successAfterFailure: false })
    const nonUtc = await runStaleCheck('America/New_York', { successAfterFailure: false })
    assert.equal(utc.lastError, 'connection refused')
    assert.equal(nonUtc.lastError, utc.lastError)
    assert.ok(nonUtc.lastAttemptAt)
    assert.ok(utc.lastAttemptAt)
  }
)

// ---------------------------------------------------------------------------------------------
// forgetContent / forgetContentBatch -- `contentId` carries no FK, so this is the application-side
// cleanup a page/asset's own deletion has to call.
// ---------------------------------------------------------------------------------------------

test(
  'forgetContent removes every target row for a page, leaving another page untouched',
  { skip },
  async () => {
    const forgottenPageId = await makePage('forget-content-target')
    const otherPageId = await makePage('forget-content-other')
    await contentSync.recordSuccess({
      contentType: 'page',
      contentId: forgottenPageId,
      targetId: pageTargetId,
      direction: 'push'
    })
    await contentSync.recordSuccess({
      contentType: 'page',
      contentId: forgottenPageId,
      targetId: otherTargetId,
      direction: 'push'
    })
    await contentSync.recordSuccess({
      contentType: 'page',
      contentId: otherPageId,
      targetId: pageTargetId,
      direction: 'push'
    })

    await contentSync.forgetContent('page', forgottenPageId)

    const forgottenStates = await readStatesForContent('page', forgottenPageId)
    assert.equal(forgottenStates.length, 0)
    const otherState = await readState('page', otherPageId, pageTargetId)
    assert.ok(otherState)
  }
)

test('forgetContent is scoped to contentType, not just contentId', { skip }, async () => {
  const pageId = await makePage('forget-content-type-scope')
  const assetId = await makeAsset('forget-content-type-scope.png')
  await contentSync.recordSuccess({
    contentType: 'page',
    contentId: pageId,
    targetId: pageTargetId,
    direction: 'push'
  })
  await contentSync.recordSuccess({
    contentType: 'asset',
    contentId: assetId,
    targetId: pageTargetId,
    direction: 'push'
  })

  await contentSync.forgetContent('asset', assetId)

  assert.equal(await readState('asset', assetId, pageTargetId), null)
  assert.ok(await readState('page', pageId, pageTargetId))
})

test(
  'forgetContentBatch removes rows for every id in the batch in one call',
  { skip },
  async () => {
    const firstId = await makePage('forget-batch-1')
    const secondId = await makePage('forget-batch-2')
    const untouchedId = await makePage('forget-batch-untouched')
    for (const contentId of [firstId, secondId, untouchedId]) {
      await contentSync.recordSuccess({
        contentType: 'page',
        contentId,
        targetId: pageTargetId,
        direction: 'push'
      })
    }

    await contentSync.forgetContentBatch('page', [firstId, secondId])

    assert.equal(await readState('page', firstId, pageTargetId), null)
    assert.equal(await readState('page', secondId, pageTargetId), null)
    assert.ok(await readState('page', untouchedId, pageTargetId))
  }
)

test('forgetContentBatch is a no-op for an empty id list', { skip }, async () => {
  // -> Just asserting it doesn't throw on `IN ()`, which some drivers reject outright.
  await contentSync.forgetContentBatch('page', [])
})

// ---------------------------------------------------------------------------------------------
// Takes its own `setupTestDb()` fixture because `pages.deletePage` needs its whole model dependency
// graph installed on the global, not just `db`.
// ---------------------------------------------------------------------------------------------

describe('forgetContent via pages.deletePage (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor
  let targetId: string

  before(async () => {
    fixtures = await setupTestDb()
    await seedLocale(fixtures.db, { code: 'en' })
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

    const [target] = await fixtures.db
      .insert(storageTable)
      .values({ siteId: fixtures.siteId, module: 'test-forget-content' })
      .returning({ id: storageTable.id })
    targetId = target!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  test('deletePage drops the page from contentSyncState and its target summary', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'docs/sync-state-delete-me',
        title: 'Sync State Delete Me',
        editor: 'markdown',
        content: '# Hello'
      },
      actor
    )

    // -> A success then a failure leaves both `lastSyncedAt` and `lastError` set, so the delete has
    //    to clear both of the fields `getTargetSummary` reads.
    await contentSync.recordSuccess({
      contentType: 'page',
      contentId: page.id,
      targetId,
      direction: 'push'
    })
    await contentSync.recordFailure({
      contentType: 'page',
      contentId: page.id,
      targetId,
      error: 'connection refused'
    })
    const beforeDelete = await readState('page', page.id, targetId)
    assert.ok(beforeDelete)

    const deleted = await pagesModel.deletePage(fixtures.siteId, page.id, actor)
    assert.equal(deleted, true)

    const afterDelete = await readState('page', page.id, targetId)
    assert.equal(afterDelete, null)

    const summary = await contentSync.getTargetSummary(targetId, { siteId: fixtures.siteId })
    assert.equal(summary.lastError, null)
    assert.equal(summary.lastSyncedAt, null)
    assert.equal(summary.lastAttemptAt, null)
  })
})

// ---------------------------------------------------------------------------------------------
// purgeOrphaned -- the backstop sweep: with no FK on `contentId`, a row whose page/asset is already
// gone is cleaned up only here or by the delete path's own cleanup.
// ---------------------------------------------------------------------------------------------

test(
  'purgeOrphaned removes a page row with no matching page, keeps a live one',
  { skip },
  async () => {
    const deletedPageId = randomUUID()
    await contentSync.recordSuccess({
      contentType: 'page',
      contentId: deletedPageId,
      targetId: pageTargetId,
      direction: 'push'
    })

    const livePageId = await makePage('purge-orphaned-live-page')
    await contentSync.recordSuccess({
      contentType: 'page',
      contentId: livePageId,
      targetId: pageTargetId,
      direction: 'push'
    })

    const count = await contentSync.purgeOrphaned()
    assert.ok(count >= 1)

    assert.equal(await readState('page', deletedPageId, pageTargetId), null)
    assert.ok(await readState('page', livePageId, pageTargetId))
  }
)

test(
  'purgeOrphaned removes an asset row with no matching asset, keeps a live one',
  { skip },
  async () => {
    const deletedAssetId = randomUUID()
    await contentSync.recordSuccess({
      contentType: 'asset',
      contentId: deletedAssetId,
      targetId: pageTargetId,
      direction: 'push'
    })

    const liveAssetId = await makeAsset('purge-orphaned-live.png')
    await contentSync.recordSuccess({
      contentType: 'asset',
      contentId: liveAssetId,
      targetId: pageTargetId,
      direction: 'push'
    })

    const count = await contentSync.purgeOrphaned()
    assert.ok(count >= 1)

    assert.equal(await readState('asset', deletedAssetId, pageTargetId), null)
    assert.ok(await readState('asset', liveAssetId, pageTargetId))
  }
)

test(
  'purgeOrphaned checks each row against the table matching its own contentType, not the other one',
  { skip },
  async () => {
    // -> A page row whose contentId happens to match a real *asset*'s id is still orphaned (nothing
    //    in `pages` matches it), and vice versa -- the two branches must not cross.
    const assetId = await makeAsset('purge-orphaned-cross-check.png')
    await contentSync.recordSuccess({
      contentType: 'page',
      contentId: assetId,
      targetId: pageTargetId,
      direction: 'push'
    })

    await contentSync.purgeOrphaned()

    assert.equal(await readState('page', assetId, pageTargetId), null)
  }
)
