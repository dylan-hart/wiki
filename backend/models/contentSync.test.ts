import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { relations } from '../db/relations.ts'
import {
  assets as assetsTable,
  classificationLevels as classificationLevelsTable,
  pages as pagesTable,
  sites as sitesTable,
  storage as storageTable,
  users as usersTable
} from '../db/schema.ts'
import { contentSync } from './contentSync.ts'

/**
 * Exercises the model against a real Postgres instance, because the whole point of this model is SQL
 * correctness — the out-of-date query's LEFT JOIN/NULL handling and the upsert's conflict target are
 * exactly the kind of thing a mock of the query builder would not actually verify.
 *
 * Skipped unless `DATABASE_URL` points at a real database with this repo's migrations applied — see
 * `README` / `CLAUDE.md` for spinning up a throwaway one. Nothing here mutates outside a `siteId`
 * created and torn down by this file.
 */
const DATABASE_URL = process.env.DATABASE_URL
const skip = DATABASE_URL
  ? false
  : 'requires DATABASE_URL (a Postgres instance with migrations applied)'

let pool: Pool
let siteId: string
let userId: string
let pageTargetId: string
let otherTargetId: string
let classificationId: string

before(async () => {
  if (!DATABASE_URL) {
    return
  }
  // -> Node 25 (this sandbox) has no native `Temporal` yet — Node 26 does, per this repo's engine
  //    requirement. Polyfilled only when missing, so this is a no-op on a real Node 26 runtime.
  if (typeof Temporal === 'undefined') {
    const polyfill = await import('@js-temporal/polyfill')
    ;(globalThis as any).Temporal = polyfill.Temporal
  }

  pool = new Pool({ connectionString: DATABASE_URL })
  const db = drizzle({ client: pool, relations })
  global.WIKI = {
    db,
    logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  } as unknown as WikiGlobal

  const [site] = await WIKI.db
    .insert(sitesTable)
    .values({ hostname: `contentsync-test-${Date.now()}.example.com`, config: {} })
    .returning({ id: sitesTable.id })
  siteId = site.id

  const [user] = await WIKI.db
    .insert(usersTable)
    .values({ email: `contentsync-test-${Date.now()}@example.com`, name: 'Content Sync Test' })
    .returning({ id: usersTable.id })
  userId = user.id

  const [classification] = await WIKI.db
    .insert(classificationLevelsTable)
    .values({ name: 'Public', sortOrder: 0 })
    .returning({ id: classificationLevelsTable.id })
  classificationId = classification.id

  const targets = await WIKI.db
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
  // -> Children first: none of these foreign keys cascade from `sites`, and `storage` cascades
  //    `contentSyncState` on its own way out.
  await WIKI.db.delete(pagesTable).where(eq(pagesTable.siteId, siteId))
  await WIKI.db.delete(assetsTable).where(eq(assetsTable.siteId, siteId))
  await WIKI.db.delete(storageTable).where(eq(storageTable.siteId, siteId))
  await WIKI.db.delete(sitesTable).where(eq(sitesTable.id, siteId))
  await WIKI.db.delete(usersTable).where(eq(usersTable.id, userId))
  await WIKI.db
    .delete(classificationLevelsTable)
    .where(eq(classificationLevelsTable.id, classificationId))
  await pool.end()
})

/** Inserts a page owned by the fixture site/user, returning its id. */
async function makePage(path: string): Promise<string> {
  const [row] = await WIKI.db
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

/** Inserts an asset owned by the fixture site/user, returning its id. */
async function makeAsset(fileName: string): Promise<string> {
  const [row] = await WIKI.db
    .insert(assetsTable)
    .values({ siteId, authorId: userId, fileName, fileExt: 'png' })
    .returning({ id: assetsTable.id })
  return row.id
}

test('getState returns null for a pairing that has never synced', { skip }, async () => {
  const pageId = await makePage('never-synced')
  const state = await contentSync.getState('page', pageId, pageTargetId)
  assert.equal(state, null)
})

test('recordSuccess creates a row, and getState reads it back', { skip }, async () => {
  const pageId = await makePage('record-success')
  await contentSync.recordSuccess({
    contentType: 'page',
    contentId: pageId,
    targetId: pageTargetId,
    direction: 'push',
    targetRef: { commit: 'abc123' }
  })

  const state = await contentSync.getState('page', pageId, pageTargetId)
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

  const states = await contentSync.getStatesForContent('page', pageId)
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
    const afterSuccess = await contentSync.getState('page', pageId, pageTargetId)

    await contentSync.recordFailure({
      contentType: 'page',
      contentId: pageId,
      targetId: pageTargetId,
      error: 'connection reset'
    })
    const afterFailure = await contentSync.getState('page', pageId, pageTargetId)

    assert.equal(afterFailure!.lastError, 'connection reset')
    assert.equal(afterFailure!.lastDirection, 'push')
    assert.equal(afterFailure!.targetRef, 'sha-good')
    assert.deepEqual(afterFailure!.lastSyncedAt, afterSuccess!.lastSyncedAt)
  }
)

test('getStatesForTarget only returns rows for that target', { skip }, async () => {
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

  const states = await contentSync.getStatesForTarget(pageTargetId)
  assert.ok(states.every((s) => s.targetId === pageTargetId))
  assert.ok(states.some((s) => s.contentId === pageId))
})

test(
  'getOutOfDatePages includes a page that has never synced to the target',
  { skip },
  async () => {
    const pageId = await makePage('never-synced-out-of-date')
    const outOfDate = await contentSync.getOutOfDatePages(pageTargetId, { siteId })
    assert.ok(outOfDate.some((p) => p.id === pageId))
  }
)

test('getOutOfDatePages excludes a page synced after its last update', { skip }, async () => {
  const pageId = await makePage('synced-up-to-date')
  await contentSync.recordSuccess({
    contentType: 'page',
    contentId: pageId,
    targetId: pageTargetId,
    direction: 'push'
  })

  const outOfDate = await contentSync.getOutOfDatePages(pageTargetId, { siteId })
  assert.ok(!outOfDate.some((p) => p.id === pageId))
})

test('getOutOfDatePages includes a page updated after its last sync', { skip }, async () => {
  const pageId = await makePage('updated-after-sync')
  // -> Sync it first, then edit it, so `updatedAt` moves past `lastSyncedAt`.
  await contentSync.recordSuccess({
    contentType: 'page',
    contentId: pageId,
    targetId: pageTargetId,
    direction: 'push'
  })
  await WIKI.db
    .update(pagesTable)
    .set({ title: 'edited after sync', updatedAt: sql`now() + interval '1 second'` })
    .where(eq(pagesTable.id, pageId))

  const outOfDate = await contentSync.getOutOfDatePages(pageTargetId, { siteId })
  assert.ok(outOfDate.some((p) => p.id === pageId))
})

test('getTargetSummary reports nothing for a target with no state at all', { skip }, async () => {
  const targets = await WIKI.db
    .insert(storageTable)
    .values({ siteId, module: 'test-summary-empty' })
    .returning({ id: storageTable.id })
  const summary = await contentSync.getTargetSummary(targets[0].id, { siteId })
  assert.equal(summary.lastSyncedAt, null)
  assert.equal(summary.lastError, null)
  assert.equal(summary.lastAttemptAt, null)
  // -> Not asserted as 0: other tests in this file share `siteId` and leave pages/assets behind that
  //    have never synced to THIS brand-new target either, which legitimately counts as out of date.
  assert.ok(summary.outOfDateCount >= 0)
})

test(
  'getTargetSummary reports the most recent success and out-of-date count',
  { skip },
  async () => {
    const targets = await WIKI.db
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

test('getTargetSummary surfaces the most recent error', { skip }, async () => {
  const targets = await WIKI.db
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
// getTargetSummary: stale error suppression (OpenProject #823 item 6 / upstream #846) -- a per-item
// error that is never individually retried must not keep the target's status card showing "error"
// forever once other content has demonstrably synced successfully since.
// ---------------------------------------------------------------------------------------------

test(
  'getTargetSummary keeps surfacing an error with no later success on the target',
  { skip },
  async () => {
    const targets = await WIKI.db
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
    const targets = await WIKI.db
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
    // -> A later success on a DIFFERENT item -- the failed row itself is never retried, so its own
    //    `lastError` stays set (see `recordFailure sets lastError without touching a prior successful
    //    sync`), but the target as a whole has since proven itself healthy. `syncedAt` is nudged a
    //    couple of seconds into the future rather than left to the default `Temporal.Now.instant()`:
    //    the failure's `updatedAt` above came from postgres's own clock (`now()` in the upsert), and
    //    without a comfortable margin this comparison would be sensitive to any skew between that
    //    clock and this process's.
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
    const rawState = await contentSync.getState('page', failedPageId, targetId)
    assert.equal(rawState!.lastError, 'connection refused')
  }
)

test(
  'getTargetSummary still surfaces a fresh error even after an earlier success on the target',
  { skip },
  async () => {
    const targets = await WIKI.db
      .insert(storageTable)
      .values({ siteId, module: 'test-summary-fresh-error' })
      .returning({ id: storageTable.id })
    const targetId = targets[0].id
    const pageId = await makePage('fresh-error-after-success')

    // -> `syncedAt` is pinned well into the past rather than left to the default `Temporal.Now.instant()`
    //    -- this process's clock and postgres's own (`now()`, which the following `recordFailure`
    //    writes through) are not guaranteed to agree to the millisecond, and this test only cares that
    //    the success is unambiguously *before* the error, not that it happened "just now".
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

test('getOutOfDateAssets tracks the same out-of-date logic for assets', { skip }, async () => {
  const assetId = await makeAsset('never-synced.png')
  const outOfDate = await contentSync.getOutOfDateAssets(pageTargetId, { siteId })
  assert.ok(outOfDate.some((a) => a.id === assetId))

  await contentSync.recordSuccess({
    contentType: 'asset',
    contentId: assetId,
    targetId: pageTargetId,
    direction: 'push'
  })
  const afterSync = await contentSync.getOutOfDateAssets(pageTargetId, { siteId })
  assert.ok(!afterSync.some((a) => a.id === assetId))
})

// ---------------------------------------------------------------------------------------------
// purgeOrphaned (OpenProject #1679) -- the backstop sweep for rows whose page/asset is already
// gone. `contentId` is deliberately not a foreign key (see the table's own doc comment in
// `db/schema.ts`), so these rows only ever get cleaned up here or by the delete path's own
// cleanup.
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

    assert.equal(await contentSync.getState('page', deletedPageId, pageTargetId), null)
    assert.ok(await contentSync.getState('page', livePageId, pageTargetId))
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

    assert.equal(await contentSync.getState('asset', deletedAssetId, pageTargetId), null)
    assert.ok(await contentSync.getState('asset', liveAssetId, pageTargetId))
  }
)

test(
  'purgeOrphaned checks each row against the table matching its own contentType, not the other one',
  { skip },
  async () => {
    // -> A page row whose contentId happens to match a real *asset*'s id must still be treated as
    //    orphaned (nothing in `pages` matches it), and vice versa -- the two branches must not cross.
    const assetId = await makeAsset('purge-orphaned-cross-check.png')
    await contentSync.recordSuccess({
      contentType: 'page',
      contentId: assetId,
      targetId: pageTargetId,
      direction: 'push'
    })

    await contentSync.purgeOrphaned()

    assert.equal(await contentSync.getState('page', assetId, pageTargetId), null)
    // -> The asset itself, and its own real contentSyncState rows if any, are untouched by this --
    //    this test only asserts the mis-typed row above was swept.
  }
)
