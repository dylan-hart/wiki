import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { users as usersTable } from '../db/schema.ts'
import type { PageActor, PageInput } from './pages.ts'

/**
 * Task 534: `listPendingForDigest` and `markManyDelivered`, the two new queries the digest job reads
 * and writes through. DB-backed rather than mocked because the interesting behavior here is genuinely
 * SQL: filtering pending `digest`-mode rows out from pending `immediate`-mode ones (a stubbed query
 * builder would only prove the stub returns what it was told to), and a bulk `UPDATE ... WHERE id IN
 * (...)` actually touching every id passed and no others.
 */
describe('pageWatchEvents digest queries (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pageWatchEventsModel: typeof import('./pageWatchEvents.ts').pageWatchEvents
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor
  let pageId: string
  let siteId: string

  before(async () => {
    fixtures = await setupTestDb()
    siteId = fixtures.siteId
    ;({ pageWatchEvents: pageWatchEventsModel } = await import('./pageWatchEvents.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }

    const page = await pagesModel.createPage(
      siteId,
      {
        path: 'digest-fixture',
        title: 'Digest Fixture',
        editor: 'markdown',
        content: '# Hi'
      } as PageInput,
      actor
    )
    pageId = page.id
  })

  after(async () => {
    await teardownTestDb()
  })

  async function makeUser(email: string): Promise<string> {
    const [user] = await fixtures.db
      .insert(usersTable)
      .values({ email, name: email, isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    return user!.id
  }

  test('listPendingForDigest only returns digest-mode, undelivered rows', async () => {
    const digestUser = await makeUser('digest-only@example.com')
    const immediateUser = await makeUser('immediate-only@example.com')
    const deliveredDigestUser = await makeUser('delivered-digest@example.com')

    const [digestRow] = await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Digest Fixture',
        pagePath: 'digest-fixture',
        userId: digestUser,
        action: 'updated',
        actorId: actor.id,
        changedFields: ['title'],
        notifyMode: 'digest'
      }
    ])
    await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Digest Fixture',
        pagePath: 'digest-fixture',
        userId: immediateUser,
        action: 'updated',
        actorId: actor.id,
        changedFields: ['title'],
        notifyMode: 'immediate'
      }
    ])
    const [alreadyDeliveredRow] = await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Digest Fixture',
        pagePath: 'digest-fixture',
        userId: deliveredDigestUser,
        action: 'updated',
        actorId: actor.id,
        changedFields: ['title'],
        notifyMode: 'digest'
      }
    ])
    await pageWatchEventsModel.markDelivered(alreadyDeliveredRow!.id)

    const pending = await pageWatchEventsModel.listPendingForDigest()
    const pendingIds = pending.map((event) => event.id)

    assert.ok(pendingIds.includes(digestRow!.id))
    assert.ok(!pendingIds.some((id) => id === alreadyDeliveredRow!.id))
    // -> The immediate-mode row is pending too (never delivered), but must not surface here
    const pendingUserIds = pending.map((event) => event.userId)
    assert.ok(!pendingUserIds.includes(immediateUser))
  })

  test('listPendingForDigest carries the captured page title/path and changed fields through', async () => {
    const digestUser = await makeUser('digest-fields@example.com')
    await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Captured Title',
        pagePath: 'captured/path',
        userId: digestUser,
        action: 'moved',
        actorId: actor.id,
        changedFields: [],
        notifyMode: 'digest'
      }
    ])

    const pending = await pageWatchEventsModel.listPendingForDigest()
    const event = pending.find((e) => e.userId === digestUser)

    assert.ok(event)
    assert.equal(event!.pageTitle, 'Captured Title')
    assert.equal(event!.pagePath, 'captured/path')
    assert.equal(event!.action, 'moved')
    assert.deepEqual(event!.changedFields, [])
    assert.equal(event!.actorId, actor.id)
  })

  test('markManyDelivered marks exactly the given ids, leaving everything else pending', async () => {
    const userA = await makeUser('bulk-a@example.com')
    const userB = await makeUser('bulk-b@example.com')

    const [rowA] = await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Digest Fixture',
        pagePath: 'digest-fixture',
        userId: userA,
        action: 'updated',
        actorId: actor.id,
        changedFields: ['title'],
        notifyMode: 'digest'
      }
    ])
    const [rowB] = await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Digest Fixture',
        pagePath: 'digest-fixture',
        userId: userB,
        action: 'updated',
        actorId: actor.id,
        changedFields: ['title'],
        notifyMode: 'digest'
      }
    ])

    await pageWatchEventsModel.markManyDelivered([rowA!.id])

    const pending = await pageWatchEventsModel.listPendingForDigest()
    const pendingIds = pending.map((event) => event.id)
    assert.ok(!pendingIds.includes(rowA!.id))
    assert.ok(pendingIds.includes(rowB!.id))
  })

  test('markManyDelivered with an empty list is a no-op', async () => {
    await assert.doesNotReject(() => pageWatchEventsModel.markManyDelivered([]))
  })
})

/**
 * Task 535: the in-app inbox's own queries — `listForUser`, `markRead`, `unreadCount`. DB-backed for
 * the same reason as the digest queries above: what matters is genuinely SQL (the partial-unread
 * filter, the site scoping, an `UPDATE ... WHERE` that is both idempotent and ownership-checked).
 */
describe('pageWatchEvents inbox queries (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pageWatchEventsModel: typeof import('./pageWatchEvents.ts').pageWatchEvents
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor
  let pageId: string
  let siteId: string
  let otherSiteId: string

  before(async () => {
    fixtures = await setupTestDb()
    siteId = fixtures.siteId
    ;({ pageWatchEvents: pageWatchEventsModel } = await import('./pageWatchEvents.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }

    const page = await pagesModel.createPage(
      siteId,
      {
        path: 'inbox-fixture',
        title: 'Inbox Fixture',
        editor: 'markdown',
        content: '# Hi'
      } as PageInput,
      actor
    )
    pageId = page.id

    // -> A second site, so `listForUser`'s site scoping has something real to exclude.
    const { sites: sitesTable } = await import('../db/schema.ts')
    const [otherSite] = await fixtures.db
      .insert(sitesTable)
      .values({ hostname: 'other.example.com', isEnabled: true, config: {} })
      .returning({ id: sitesTable.id })
    otherSiteId = otherSite!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  async function makeUser(email: string): Promise<string> {
    const [user] = await fixtures.db
      .insert(usersTable)
      .values({ email, name: email, isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    return user!.id
  }

  test("listForUser returns only this user's unread rows on this site, newest first", async () => {
    const userId = await makeUser('inbox-list@example.com')

    const [older] = await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Inbox Fixture',
        pagePath: 'inbox-fixture',
        userId,
        action: 'updated',
        actorId: actor.id,
        changedFields: ['title'],
        notifyMode: 'digest'
      }
    ])
    const [newer] = await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Inbox Fixture',
        pagePath: 'inbox-fixture',
        userId,
        action: 'moved',
        actorId: actor.id,
        changedFields: [],
        notifyMode: 'immediate'
      }
    ])
    // -> Already read: must not surface in the unread inbox.
    const [read] = await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Inbox Fixture',
        pagePath: 'inbox-fixture',
        userId,
        action: 'deleted',
        actorId: actor.id,
        changedFields: [],
        notifyMode: 'digest'
      }
    ])
    await pageWatchEventsModel.markRead(read!.id, userId)
    // -> Another user's row: must not leak across users.
    const otherUserId = await makeUser('inbox-other-user@example.com')
    await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Inbox Fixture',
        pagePath: 'inbox-fixture',
        userId: otherUserId,
        action: 'updated',
        actorId: actor.id,
        changedFields: ['title'],
        notifyMode: 'digest'
      }
    ])
    // -> Same user, other site: must not leak across sites.
    await pageWatchEventsModel.recordMany([
      {
        siteId: otherSiteId,
        pageId,
        pageTitle: 'Inbox Fixture',
        pagePath: 'inbox-fixture',
        userId,
        action: 'updated',
        actorId: actor.id,
        changedFields: ['title'],
        notifyMode: 'digest'
      }
    ])

    const rows = await pageWatchEventsModel.listForUser(userId, siteId)
    const ids = rows.map((r) => r.id)

    assert.deepEqual(ids, [newer!.id, older!.id])
    assert.ok(!ids.includes(read!.id))
    assert.equal(rows[0]!.action, 'moved')
    assert.equal(rows[0]!.pageTitle, 'Inbox Fixture')
    assert.equal(rows[0]!.actorId, actor.id)
  })

  test('markRead sets readAt and is idempotent', async () => {
    const userId = await makeUser('inbox-markread@example.com')
    const [row] = await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Inbox Fixture',
        pagePath: 'inbox-fixture',
        userId,
        action: 'updated',
        actorId: actor.id,
        changedFields: ['title'],
        notifyMode: 'digest'
      }
    ])

    const firstResult = await pageWatchEventsModel.markRead(row!.id, userId)
    assert.equal(firstResult, true)

    const rows = await pageWatchEventsModel.listForUser(userId, siteId)
    assert.ok(!rows.some((r) => r.id === row!.id))

    // -> Marking an already-read row again is a no-op, not a failure — same idempotency shape as
    //    `unwatch`/`watch` elsewhere in this feature.
    const secondResult = await pageWatchEventsModel.markRead(row!.id, userId)
    assert.equal(secondResult, true)
  })

  test('markRead answers false for a row that does not belong to the caller', async () => {
    const ownerId = await makeUser('inbox-owner@example.com')
    const strangerId = await makeUser('inbox-stranger@example.com')
    const [row] = await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Inbox Fixture',
        pagePath: 'inbox-fixture',
        userId: ownerId,
        action: 'updated',
        actorId: actor.id,
        changedFields: ['title'],
        notifyMode: 'digest'
      }
    ])

    const result = await pageWatchEventsModel.markRead(row!.id, strangerId)
    assert.equal(result, false)

    // -> Untouched: the owner can still read and later mark it themselves.
    const rows = await pageWatchEventsModel.listForUser(ownerId, siteId)
    assert.ok(rows.some((r) => r.id === row!.id))
  })

  test("unreadCount counts only this user's unread rows on this site", async () => {
    const userId = await makeUser('inbox-count@example.com')
    await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Inbox Fixture',
        pagePath: 'inbox-fixture',
        userId,
        action: 'updated',
        actorId: actor.id,
        changedFields: ['title'],
        notifyMode: 'digest'
      },
      {
        siteId,
        pageId,
        pageTitle: 'Inbox Fixture',
        pagePath: 'inbox-fixture',
        userId,
        action: 'moved',
        actorId: actor.id,
        changedFields: [],
        notifyMode: 'digest'
      }
    ])
    const [readRow] = await pageWatchEventsModel.recordMany([
      {
        siteId,
        pageId,
        pageTitle: 'Inbox Fixture',
        pagePath: 'inbox-fixture',
        userId,
        action: 'deleted',
        actorId: actor.id,
        changedFields: [],
        notifyMode: 'digest'
      }
    ])
    await pageWatchEventsModel.markRead(readRow!.id, userId)

    const count = await pageWatchEventsModel.unreadCount(userId, siteId)
    assert.equal(count, 2)
  })
})
