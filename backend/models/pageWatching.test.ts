import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  groups as groupsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'
import type { PageActor, PageInput } from './pages.ts'
import type { GroupRule } from './groups.ts'

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
  let pageWatchEventsModel: typeof import('./pageWatchEvents.ts').pageWatchEvents
  let pagesModel: typeof import('./pages.ts').pages
  let groupsModel: typeof import('./groups.ts').groups
  let resolvePreference: typeof import('./pageWatching.ts').resolvePreference
  let wantsAction: typeof import('./pageWatching.ts').wantsAction
  let actor: PageActor
  let pageId: string
  let pagePath: string
  let pageClassification: string
  let watcherId: string
  let readerGroupId: string

  const allowReadRule = (overrides: Partial<GroupRule> = {}): GroupRule => ({
    id: 'allow-read',
    name: 'Allow read',
    roles: ['read:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: [],
    sites: [],
    ...overrides
  })

  before(async () => {
    fixtures = await setupTestDb()
    ;({
      pageWatching: pageWatchingModel,
      resolvePreference,
      wantsAction
    } = await import('./pageWatching.ts'))
    ;({ pageWatchEvents: pageWatchEventsModel } = await import('./pageWatchEvents.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ groups: groupsModel } = await import('./groups.ts'))
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
    pagePath = page.path
    pageClassification = page.classification

    const [watcher] = await fixtures.db
      .insert(usersTable)
      .values({ email: 'watcher@example.com', name: 'Watcher', isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    watcherId = watcher!.id

    // -> A group granting `read:pages` everywhere, so the watcher can actually be told about a change
    //    in the first place — checkAccess denies by default (see `helpers/pageRules.ts`), so without
    //    this every test below (not just the OpenProject #2173 ones) would find the watcher excluded.
    const [readerGroup] = await fixtures.db
      .insert(groupsTable)
      .values({ name: 'Reader', permissions: [], rules: [allowReadRule()] })
      .returning({ id: groupsTable.id })
    readerGroupId = readerGroup!.id
    await fixtures.db.insert(userGroupsTable).values({ userId: watcherId, groupId: readerGroupId })
    await groupsModel.reloadCache()
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

  /**
   * OpenProject #2173: `read:pages` used to be checked once, when a watcher first pressed the bell,
   * and never again — so a watcher whose access was later revoked (a raised classification, a move
   * into a restricted branch, an edited group rule) kept being queued notifications and kept seeing
   * them in both listings. It is now re-checked live, against the watcher's CURRENT groups, at both
   * of the places that matter: `listWatchers` (send time — who a change gets queued for) and the two
   * read-time listings (`pageWatchEvents.listForUser`'s notification inbox, and this model's own
   * `listForUser` behind the watch-list route).
   */
  describe('read:pages re-checked at send time and read time, not only at subscribe time', () => {
    test('while the watcher still holds read:pages, they are included in listWatchers, the notification listing, and the watch list route', async () => {
      await pageWatchingModel.watch({ siteId: fixtures.siteId, pageId, userId: watcherId })

      const ref = {
        path: pagePath,
        locale: 'en',
        siteId: fixtures.siteId,
        classification: pageClassification,
        tags: []
      }
      const watchers = await pageWatchingModel.listWatchers(pageId, fixtures.userId, 'updated', ref)
      assert.ok(watchers.some((w) => w.userId === watcherId))

      const [{ id: eventId }] = await pageWatchEventsModel.recordMany([
        {
          siteId: fixtures.siteId,
          pageId,
          pageTitle: 'Preferences Fixture',
          pagePath,
          pageLocale: 'en',
          userId: watcherId,
          action: 'updated',
          actorId: fixtures.userId,
          changedFields: [],
          notifyMode: 'digest'
        }
      ])
      const notifications = await pageWatchEventsModel.listForUser(watcherId, fixtures.siteId)
      assert.ok(notifications.some((n) => n.id === eventId))

      const watchList = await pageWatchingModel.listForUser(fixtures.siteId, watcherId)
      assert.ok(watchList.some((w) => w.pageId === pageId))

      await pageWatchingModel.unwatch({ pageId, userId: watcherId })
    })

    test('once read:pages is revoked, the watcher is excluded from listWatchers, their notification listing, and the watch list route — but can still unwatch', async () => {
      await pageWatchingModel.watch({ siteId: fixtures.siteId, pageId, userId: watcherId })

      const [{ id: eventId }] = await pageWatchEventsModel.recordMany([
        {
          siteId: fixtures.siteId,
          pageId,
          pageTitle: 'Preferences Fixture',
          pagePath,
          pageLocale: 'en',
          userId: watcherId,
          action: 'updated',
          actorId: fixtures.userId,
          changedFields: [],
          notifyMode: 'digest'
        }
      ])

      // -> The revocation: the group's only rule now DENIES read:pages instead of allowing it —
      //    an ordinary lifecycle event (an admin editing a group rule), not anything the watcher did.
      await fixtures.db
        .update(groupsTable)
        .set({ rules: [allowReadRule({ mode: 'DENY' })] })
        .where(eq(groupsTable.id, readerGroupId))
      await groupsModel.reloadCache()

      const ref = {
        path: pagePath,
        locale: 'en',
        siteId: fixtures.siteId,
        classification: pageClassification,
        tags: []
      }
      const watchers = await pageWatchingModel.listWatchers(pageId, fixtures.userId, 'updated', ref)
      assert.equal(
        watchers.some((w) => w.userId === watcherId),
        false
      )

      const notifications = await pageWatchEventsModel.listForUser(watcherId, fixtures.siteId)
      assert.equal(
        notifications.some((n) => n.id === eventId),
        false
      )

      const watchList = await pageWatchingModel.listForUser(fixtures.siteId, watcherId)
      assert.equal(
        watchList.some((w) => w.pageId === pageId),
        false
      )

      // -> Unwatching a page one can no longer read must keep working (`api/watching.ts`'s own
      //    doc comment on why the page is never loaded first for this route).
      await pageWatchingModel.unwatch({ pageId, userId: watcherId })
      assert.equal(await pageWatchingModel.isWatching(pageId, watcherId), false)

      // -> Restore the ALLOW rule so nothing later in this suite is affected by the revocation.
      await fixtures.db
        .update(groupsTable)
        .set({ rules: [allowReadRule()] })
        .where(eq(groupsTable.id, readerGroupId))
      await groupsModel.reloadCache()
    })
  })

  test('resolvePreference and wantsAction agree on which change types a resolved preference wants', () => {
    const preference = resolvePreference({ notifyOnMoved: false })
    assert.equal(wantsAction(preference, 'updated'), true)
    assert.equal(wantsAction(preference, 'moved'), false)
    assert.equal(wantsAction(preference, 'deleted'), true)
  })
})
