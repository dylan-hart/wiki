import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { pageWatchEvents as pageWatchEventsTable, users as usersTable } from '../db/schema.ts'
import type { PageActor, PageInput } from './pages.ts'
import { task as notifyPageWatchers } from '../tasks/simple/notify-page-watchers.ts'

/**
 * `models/pages.ts`'s create/update/move/delete are almost entirely SQL — inserts, duplicate-path
 * checks, and coordination with the tree and history tables — so a mock of the query builder would
 * mostly be re-describing the code under test rather than verifying it. This suite runs the real
 * methods against a migrated, per-run-fresh database (see `test/db.ts`).
 */
describe('pages create/update/move/delete (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'] }
  })

  after(async () => {
    await teardownTestDb()
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'getting-started',
      title: 'Getting Started',
      editor: 'markdown',
      content: '# Hello\n\nSome content.',
      ...overrides
    }
  }

  test('createPage inserts a page and gives it a place in the tree', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/create-me', title: 'Create Me' }),
      actor
    )

    assert.equal(page.path, 'docs/create-me')
    assert.equal(page.title, 'Create Me')
    assert.equal(page.locale, 'en')
    assert.equal(page.authorId, fixtures.userId)

    const fetched = await pagesModel.getPage({ siteId: fixtures.siteId, id: page.id })
    assert.ok(fetched)
    assert.equal(fetched!.path, 'docs/create-me')
  })

  test('createPage refuses an empty title', async () => {
    await assert.rejects(
      pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/no-title', title: '  ' }),
        actor
      ),
      /pageTitleMissing/
    )
  })

  test('createPage refuses a path already taken in the same locale', async () => {
    await pagesModel.createPage(fixtures.siteId, pageInput({ path: 'docs/collide' }), actor)

    await assert.rejects(
      pagesModel.createPage(fixtures.siteId, pageInput({ path: 'docs/collide' }), actor),
      /pageDuplicatePath/
    )
  })

  test('the same path is free again in a different locale', async () => {
    const en = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/locale-variant', locale: 'en' }),
      actor
    )
    const fr = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/locale-variant', locale: 'fr', title: 'Bien démarrer' }),
      actor
    )

    assert.notEqual(en.id, fr.id)
    assert.equal(en.locale, 'en')
    assert.equal(fr.locale, 'fr')
    assert.equal(fr.path, 'docs/locale-variant')

    const fetchedEn = await pagesModel.getPage({ siteId: fixtures.siteId, id: en.id })
    const fetchedFr = await pagesModel.getPage({ siteId: fixtures.siteId, id: fr.id })
    assert.equal(fetchedEn!.title, 'Getting Started')
    assert.equal(fetchedFr!.title, 'Bien démarrer')
  })

  test('updatePage changes only the fields present in the patch', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/update-me', description: 'original description' }),
      actor
    )

    const updated = await pagesModel.updatePage(
      fixtures.siteId,
      page.id,
      { title: 'Updated Title' },
      actor
    )

    assert.equal(updated!.title, 'Updated Title')
    // -> Untouched: not part of the patch
    assert.equal(updated!.description, 'original description')
  })

  test('updatePage returns null for a page that does not exist', async () => {
    const updated = await pagesModel.updatePage(
      fixtures.siteId,
      '00000000-0000-4000-8000-000000000000',
      { title: 'Anything' },
      actor
    )
    assert.equal(updated, null)
  })

  test('movePage relocates the page and its tree entry, and rejects a colliding destination', async () => {
    const source = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/move-source' }),
      actor
    )
    await pagesModel.createPage(fixtures.siteId, pageInput({ path: 'docs/move-taken' }), actor)

    await assert.rejects(
      pagesModel.movePage(fixtures.siteId, source.id, { path: 'docs/move-taken' }, actor),
      /pageDuplicatePath/
    )

    const moved = await pagesModel.movePage(
      fixtures.siteId,
      source.id,
      { path: 'docs/move-destination', title: 'Moved' },
      actor
    )

    assert.equal(moved!.path, 'docs/move-destination')
    assert.equal(moved!.title, 'Moved')

    // -> The old path is free again, since the page that held it moved rather than staying to block it
    const reoccupied = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/move-source', title: 'Reoccupied' }),
      actor
    )
    assert.equal(reoccupied.path, 'docs/move-source')
  })

  test('movePage moving to its own current path is a no-op that still succeeds', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/stay-put' }),
      actor
    )
    const result = await pagesModel.movePage(
      fixtures.siteId,
      page.id,
      { path: 'docs/stay-put' },
      actor
    )
    assert.equal(result!.id, page.id)
    assert.equal(result!.path, 'docs/stay-put')
  })

  test('deletePage removes the page and frees its path for reuse', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/delete-me' }),
      actor
    )

    const deleted = await pagesModel.deletePage(fixtures.siteId, page.id, actor)
    assert.equal(deleted, true)

    const fetched = await pagesModel.getPage({ siteId: fixtures.siteId, id: page.id })
    assert.equal(fetched, null)

    const recreated = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/delete-me', title: 'Recreated' }),
      actor
    )
    assert.equal(recreated.path, 'docs/delete-me')
  })

  test('deletePage returns false for a page that does not exist', async () => {
    const deleted = await pagesModel.deletePage(
      fixtures.siteId,
      '00000000-0000-4000-8000-000000000000',
      actor
    )
    assert.equal(deleted, false)
  })
})

/**
 * The change-event trigger `updatePage`/`movePage`/`deletePage`/`deleteOrphaned` queue after
 * `pageHistory.record()` (`models/pages.ts#notifyWatchers`). `WIKI.scheduler` is a stub here (see
 * `test/db.ts`) that records `addJob` calls instead of actually running a worker pool, so each test
 * drives the queued `notifyPageWatchers` task itself against the payload the trigger produced — which
 * exercises the real pipeline end to end without needing a live scheduler.
 */
describe('pages watch-notification trigger (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor
  let watcherId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'] }
    const [watcher] = await fixtures.db
      .insert(usersTable)
      .values({ email: 'watcher@example.com', name: 'Watcher', isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    watcherId = watcher!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'watched-page',
      title: 'Watched Page',
      editor: 'markdown',
      content: '# Hello',
      ...overrides
    }
  }

  /** Runs every `notifyPageWatchers` job the stub scheduler was handed since the last call. */
  async function drainQueuedNotifications(): Promise<void> {
    const addJob = WIKI.scheduler.addJob as unknown as {
      mock: {
        calls: { arguments: [{ task: string; payload: any }]; result: any }[]
        resetCalls: () => void
      }
    }
    const calls = addJob.mock.calls.filter(
      (call) => call.arguments[0].task === 'notifyPageWatchers'
    )
    for (const call of calls) {
      await notifyPageWatchers(call.arguments[0].payload)
    }
    addJob.mock.resetCalls()
  }

  async function pendingEventsFor(
    pageId: string
  ): Promise<(typeof pageWatchEventsTable.$inferSelect)[]> {
    return fixtures.db
      .select()
      .from(pageWatchEventsTable)
      .where(eq(pageWatchEventsTable.pageId, pageId))
  }

  test('createPage queues nothing: nobody can be watching a page before it exists', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/create-me' }),
      actor
    )
    const events = await pendingEventsFor(page.id)
    assert.deepEqual(events, [])
  })

  test('updatePage queues a pending notification for a watcher, excluding the actor themselves', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/update-me' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })
    // -> The actor also watches their own page -- they must not be notified about their own edit
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: actor.id
    })

    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Updated' }, actor)
    await drainQueuedNotifications()

    const events = await pendingEventsFor(page.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.userId, watcherId)
    assert.equal(events[0]!.action, 'updated')
    assert.equal(events[0]!.deliveredAt, null)
  })

  test('updatePage queues nothing when the page has no watchers', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/no-watchers' }),
      actor
    )
    await pagesModel.updatePage(fixtures.siteId, page.id, { title: 'Still unwatched' }, actor)
    await drainQueuedNotifications()

    assert.deepEqual(await pendingEventsFor(page.id), [])
  })

  test('movePage queues a "moved" notification for a watcher', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/move-me' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })

    await pagesModel.movePage(fixtures.siteId, page.id, { path: 'watch/moved-to' }, actor)
    await drainQueuedNotifications()

    const events = await pendingEventsFor(page.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.action, 'moved')
  })

  test('deletePage queues a "deleted" notification, surviving the cascade that removes the watch itself', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'watch/delete-me' }),
      actor
    )
    await WIKI.models.pageWatching.watch({
      siteId: fixtures.siteId,
      pageId: page.id,
      userId: watcherId
    })

    await pagesModel.deletePage(fixtures.siteId, page.id, actor)
    await drainQueuedNotifications()

    const events = await pendingEventsFor(page.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.userId, watcherId)
    assert.equal(events[0]!.action, 'deleted')

    // -> The watch row itself is gone with the page (FK cascade) -- only the pending event survives it
    assert.equal(await WIKI.models.pageWatching.isWatching(page.id, watcherId), false)
  })
})
