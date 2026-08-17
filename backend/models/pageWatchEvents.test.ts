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
    actor = { id: fixtures.userId, permissions: ['manage:system'] }

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
