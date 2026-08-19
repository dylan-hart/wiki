import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { users as usersTable } from '../db/schema.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * Task 530: the delivery preference on a watch — `watch()` accepting and persisting it,
 * `setPreference()` changing it after the fact, and the defaults every unset field resolves to.
 *
 * DB-backed rather than mocked: the interesting behavior is the unique-index-driven idempotency of
 * `watch()` (a second call must NOT clobber a preference already stored) and a partial `UPDATE` in
 * `setPreference()` (fields left out of the call must survive untouched) — both are properties of
 * the actual SQL, not of this file's own logic, so a stubbed query builder would only be testing that
 * the stub does what the stub was told to do.
 */
describe('pageWatching preferences (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pageWatchingModel: typeof import('./pageWatching.ts').pageWatching
  let pagesModel: typeof import('./pages.ts').pages
  let resolvePreference: typeof import('./pageWatching.ts').resolvePreference
  let wantsAction: typeof import('./pageWatching.ts').wantsAction
  let actor: PageActor
  let pageId: string
  let watcherId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({
      pageWatching: pageWatchingModel,
      resolvePreference,
      wantsAction
    } = await import('./pageWatching.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }

    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'preferences-fixture',
        title: 'Preferences Fixture',
        editor: 'markdown',
        content: '# Hi'
      } as PageInput,
      actor
    )
    pageId = page.id

    const [watcher] = await fixtures.db
      .insert(usersTable)
      .values({ email: 'watcher@example.com', name: 'Watcher', isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    watcherId = watcher!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  test('watch() with no preference leaves every column null, and getPreference resolves defaults', async () => {
    await pageWatchingModel.watch({ siteId: fixtures.siteId, pageId, userId: watcherId })

    const preference = await pageWatchingModel.getPreference(pageId, watcherId)
    assert.deepEqual(preference, {
      notifyMode: 'digest',
      notifyOnEdited: true,
      notifyOnMoved: true,
      notifyOnDeleted: true
    })

    await pageWatchingModel.unwatch({ pageId, userId: watcherId })
  })

  test('watch() persists a preference passed on the first watch', async () => {
    await pageWatchingModel.watch({
      siteId: fixtures.siteId,
      pageId,
      userId: watcherId,
      notifyMode: 'immediate',
      notifyOnMoved: false
    })

    assert.deepEqual(await pageWatchingModel.getPreference(pageId, watcherId), {
      notifyMode: 'immediate',
      notifyOnEdited: true,
      notifyOnMoved: false,
      notifyOnDeleted: true
    })

    await pageWatchingModel.unwatch({ pageId, userId: watcherId })
  })

  test('watch() called again on an existing watch does not overwrite its stored preference', async () => {
    await pageWatchingModel.watch({
      siteId: fixtures.siteId,
      pageId,
      userId: watcherId,
      notifyMode: 'immediate'
    })

    // Re-watching (the button pressed twice) with a different preference in the body must be a no-op.
    await pageWatchingModel.watch({
      siteId: fixtures.siteId,
      pageId,
      userId: watcherId,
      notifyMode: 'digest'
    })

    const preference = await pageWatchingModel.getPreference(pageId, watcherId)
    assert.equal(preference?.notifyMode, 'immediate')

    await pageWatchingModel.unwatch({ pageId, userId: watcherId })
  })

  test('setPreference() partially updates: fields left out survive unchanged', async () => {
    await pageWatchingModel.watch({
      siteId: fixtures.siteId,
      pageId,
      userId: watcherId,
      notifyMode: 'immediate',
      notifyOnDeleted: false
    })

    const existed = await pageWatchingModel.setPreference({
      pageId,
      userId: watcherId,
      notifyOnEdited: false
    })
    assert.equal(existed, true)

    assert.deepEqual(await pageWatchingModel.getPreference(pageId, watcherId), {
      notifyMode: 'immediate',
      notifyOnEdited: false,
      notifyOnMoved: true,
      notifyOnDeleted: false
    })

    await pageWatchingModel.unwatch({ pageId, userId: watcherId })
  })

  test('setPreference() on a page nobody is watching returns false and creates nothing', async () => {
    const existed = await pageWatchingModel.setPreference({
      pageId,
      userId: watcherId,
      notifyMode: 'immediate'
    })
    assert.equal(existed, false)
    assert.equal(await pageWatchingModel.isWatching(pageId, watcherId), false)
  })

  test('listForUser resolves each row’s preference alongside the page it is joined to', async () => {
    await pageWatchingModel.watch({
      siteId: fixtures.siteId,
      pageId,
      userId: watcherId,
      notifyMode: 'immediate',
      notifyOnMoved: false
    })

    const [watched] = await pageWatchingModel.listForUser(fixtures.siteId, watcherId)
    assert.equal(watched?.pageId, pageId)
    assert.deepEqual(watched?.preference, {
      notifyMode: 'immediate',
      notifyOnEdited: true,
      notifyOnMoved: false,
      notifyOnDeleted: true
    })

    await pageWatchingModel.unwatch({ pageId, userId: watcherId })
  })

  test('resolvePreference and wantsAction agree on which change types a resolved preference wants', () => {
    const preference = resolvePreference({ notifyOnMoved: false })
    assert.equal(wantsAction(preference, 'updated'), true)
    assert.equal(wantsAction(preference, 'moved'), false)
    assert.equal(wantsAction(preference, 'deleted'), true)
  })
})
