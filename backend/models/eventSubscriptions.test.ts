import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { users as usersTable } from '../db/schema.ts'

/**
 * OpenProject #2484: the model's own subscribe/unsubscribe/list CRUD, DB-backed since the interesting
 * behavior — the unique-index-driven idempotency of `subscribe()`, and `listSubscribers()` scoping
 * strictly to one event — is a property of the actual SQL, not of this file's own logic, matching the
 * same reasoning `models/pageWatching.test.ts`'s own preferences suite documents for its `watch()`.
 */
describe('eventSubscriptions (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let eventSubscriptionsModel: typeof import('./eventSubscriptions.ts').eventSubscriptions
  let otherUserId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ eventSubscriptions: eventSubscriptionsModel } = await import('./eventSubscriptions.ts'))

    const [otherUser] = await fixtures.db
      .insert(usersTable)
      .values({ email: 'other@example.com', name: 'Other User', isActive: true })
      .returning({ id: usersTable.id })
    otherUserId = otherUser!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  test('a user starts out not subscribed to any event', async () => {
    assert.equal(await eventSubscriptionsModel.isSubscribed(fixtures.userId, 'page:create'), false)
  })

  test('subscribe() then isSubscribed() reports true, only for that event', async () => {
    await eventSubscriptionsModel.subscribe(fixtures.userId, 'comment:new')

    assert.equal(await eventSubscriptionsModel.isSubscribed(fixtures.userId, 'comment:new'), true)
    assert.equal(await eventSubscriptionsModel.isSubscribed(fixtures.userId, 'comment:edit'), false)
  })

  test('subscribe() is idempotent: subscribing twice is subscribing once', async () => {
    await eventSubscriptionsModel.subscribe(fixtures.userId, 'asset:upload')
    await eventSubscriptionsModel.subscribe(fixtures.userId, 'asset:upload')

    const subscribers = await eventSubscriptionsModel.listSubscribers('asset:upload')
    assert.deepEqual(
      subscribers.filter((id) => id === fixtures.userId),
      [fixtures.userId]
    )
  })

  test('unsubscribe() removes the subscription; unsubscribing again is a no-op, not an error', async () => {
    await eventSubscriptionsModel.subscribe(fixtures.userId, 'user:login')
    await eventSubscriptionsModel.unsubscribe(fixtures.userId, 'user:login')

    assert.equal(await eventSubscriptionsModel.isSubscribed(fixtures.userId, 'user:login'), false)

    // -> Second unsubscribe, on an already-absent row: must not throw
    await eventSubscriptionsModel.unsubscribe(fixtures.userId, 'user:login')
  })

  test('listSubscribers() returns every subscribed user for an event, and nobody else', async () => {
    await eventSubscriptionsModel.subscribe(fixtures.userId, 'approval:submitted')
    await eventSubscriptionsModel.subscribe(otherUserId, 'approval:submitted')

    const subscribers = await eventSubscriptionsModel.listSubscribers('approval:submitted')

    assert.deepEqual(subscribers.sort(), [fixtures.userId, otherUserId].sort())
  })

  test('listSubscribers() is scoped strictly to the requested event', async () => {
    await eventSubscriptionsModel.subscribe(fixtures.userId, 'page:rename')

    const subscribers = await eventSubscriptionsModel.listSubscribers('page:delete')

    assert.ok(!subscribers.includes(fixtures.userId))
  })
})
