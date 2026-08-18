import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { sites as sitesTable } from '../db/schema.ts'

/**
 * Regression test for task 698: `Hooks.emit()` used to queue a delivery for every hook subscribed to
 * an event, with no regard for which site the event happened on. This suite covers the fix — a
 * nullable `hooks.siteId` column, null meaning "all sites" — against a real migrated database, since
 * the behavior under test is the SQL filter itself (`siteId IS NULL OR siteId = event's siteId`)
 * rather than anything worth re-describing behind a mock.
 */
describe('hooks per-site scoping (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let hooksModel: typeof import('./hooks.ts').hooks
  let otherSiteId: string
  let addJob: ReturnType<typeof mock.fn>

  before(async () => {
    fixtures = await setupTestDb()
    ;({ hooks: hooksModel } = await import('./hooks.ts'))

    const [otherSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'other-site.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    otherSiteId = otherSite!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  // -> `emit()` never throws, but it does queue through `WIKI.scheduler.addJob` — the piece of the
  //    real scheduler this suite's minimal `WIKI` (see `test/db.ts`) does not install.
  before(() => {
    addJob = mock.fn(async () => ({ id: 'job-id' }))
    ;(globalThis as any).WIKI.scheduler = { addJob }
  })

  test('a hook scoped to site A does not fire for an event on site B; the unscoped hook does', async () => {
    const scopedHookId = await hooksModel.createHook({
      name: 'Site A only',
      events: ['page:create'],
      url: 'https://example.com/site-a',
      siteId: fixtures.siteId
    })
    const unscopedHookId = await hooksModel.createHook({
      name: 'All sites',
      events: ['page:create'],
      url: 'https://example.com/all-sites'
    })

    addJob.mock.resetCalls()
    const queued = await hooksModel.emit('page:create', { id: 'page-1' }, otherSiteId)

    assert.equal(queued, 1)
    const queuedHookIds = addJob.mock.calls.map(
      (call) => (call.arguments[0] as { payload: { hookId: string } }).payload.hookId
    )
    assert.deepEqual(queuedHookIds, [unscopedHookId])
    assert.ok(!queuedHookIds.includes(scopedHookId))
  })

  test("an event on the scoped hook's own site reaches both the scoped and the unscoped hook", async () => {
    const scopedHookId = await hooksModel.createHook({
      name: 'Site A only (2)',
      events: ['page:edit'],
      url: 'https://example.com/site-a-2',
      siteId: fixtures.siteId
    })
    const unscopedHookId = await hooksModel.createHook({
      name: 'All sites (2)',
      events: ['page:edit'],
      url: 'https://example.com/all-sites-2'
    })

    addJob.mock.resetCalls()
    const queued = await hooksModel.emit('page:edit', { id: 'page-2' }, fixtures.siteId)

    assert.equal(queued, 2)
    const queuedHookIds = addJob.mock.calls
      .map((call) => (call.arguments[0] as { payload: { hookId: string } }).payload.hookId)
      .sort()
    assert.deepEqual(queuedHookIds, [scopedHookId, unscopedHookId].sort())
  })

  test('a site-less event (e.g. user:join) only reaches unscoped hooks', async () => {
    const scopedHookId = await hooksModel.createHook({
      name: 'Site A only (3)',
      events: ['user:join'],
      url: 'https://example.com/site-a-3',
      siteId: fixtures.siteId
    })
    const unscopedHookId = await hooksModel.createHook({
      name: 'All sites (3)',
      events: ['user:join'],
      url: 'https://example.com/all-sites-3'
    })

    addJob.mock.resetCalls()
    const queued = await hooksModel.emit('user:join', { userId: 'user-1' })

    assert.equal(queued, 1)
    const queuedHookIds = addJob.mock.calls.map(
      (call) => (call.arguments[0] as { payload: { hookId: string } }).payload.hookId
    )
    assert.deepEqual(queuedHookIds, [unscopedHookId])
    assert.ok(!queuedHookIds.includes(scopedHookId))
  })

  test('createHook defaults siteId to null, and updateHook can change it', async () => {
    const hookId = await hooksModel.createHook({
      name: 'Default scope',
      events: ['page:create'],
      url: 'https://example.com/default-scope'
    })
    const created = await hooksModel.getHookById(hookId)
    assert.equal(created?.siteId, null)

    await hooksModel.updateHook(hookId, { siteId: fixtures.siteId })
    const scoped = await hooksModel.getHookById(hookId)
    assert.equal(scoped?.siteId, fixtures.siteId)

    await hooksModel.updateHook(hookId, { siteId: null })
    const unscoped = await hooksModel.getHookById(hookId)
    assert.equal(unscoped?.siteId, null)
  })
})
