import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { users as usersTable } from '../db/schema.ts'

/**
 * Task 2481: the storage half of the per-user, per-event-type email notification toggle
 * (`getEmailNotificationEvents`/`setEmailNotificationEvents`, `prefs.notifications.events`) and the
 * subscriber query `models/hooks.ts#Hooks.emit()`'s email fan-out actually calls
 * (`listEmailSubscribers`). DB-backed: `listEmailSubscribers` is real SQL orchestration (a jsonb
 * containment query) worth verifying against Postgres itself, not a mock of the query builder, and
 * the get/set pair round-trips through the same `prefs` column.
 */
let fixtures: TestFixtures

before(async () => {
  if (!hasTestDatabase()) {
    return
  }
  fixtures = await setupTestDb()
})

after(async () => {
  if (!hasTestDatabase()) {
    return
  }
  await teardownTestDb()
})

describe(
  'users.getEmailNotificationEvents / setEmailNotificationEvents (DB-backed)',
  {
    skip: !hasTestDatabase()
  },
  () => {
    let usersModel: typeof import('./users.ts').users

    before(async () => {
      ;({ users: usersModel } = await import('./users.ts'))
    })

    test('a user with no preference set has no subscribed events', async () => {
      const events = await usersModel.getEmailNotificationEvents(fixtures.userId)
      assert.deepEqual(events, [])
    })

    test('setEmailNotificationEvents persists the list and reads it back', async () => {
      const saved = await usersModel.setEmailNotificationEvents(fixtures.userId, [
        'page:create',
        'comment:new'
      ])
      assert.deepEqual(saved, ['page:create', 'comment:new'])

      const reloaded = await usersModel.getEmailNotificationEvents(fixtures.userId)
      assert.deepEqual(reloaded.sort(), ['comment:new', 'page:create'])
    })

    test('silently drops an event name outside HOOK_EVENTS', async () => {
      const saved = await usersModel.setEmailNotificationEvents(fixtures.userId, [
        'page:create',
        'not:a:real:event'
      ])
      assert.deepEqual(saved, ['page:create'])
    })

    test('replaces (not merges) the previous list', async () => {
      await usersModel.setEmailNotificationEvents(fixtures.userId, ['page:create', 'comment:new'])
      const saved = await usersModel.setEmailNotificationEvents(fixtures.userId, ['page:delete'])
      assert.deepEqual(saved, ['page:delete'])

      const reloaded = await usersModel.getEmailNotificationEvents(fixtures.userId)
      assert.deepEqual(reloaded, ['page:delete'])
    })

    test('leaves other prefs (e.g. a saved editor config) untouched', async () => {
      await usersModel.setEditorSettings(fixtures.userId, 'markdown', { theme: 'dark' })
      await usersModel.setEmailNotificationEvents(fixtures.userId, ['page:create'])

      const editorSettings = await usersModel.getEditorSettings(fixtures.userId, 'markdown')
      assert.deepEqual(editorSettings, { theme: 'dark' })
    })

    test('returns null for a user that does not exist', async () => {
      const result = await usersModel.setEmailNotificationEvents(
        '00000000-0000-4000-8000-000000000000',
        ['page:create']
      )
      assert.equal(result, null)
    })
  }
)

describe('users.listEmailSubscribers (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users
  let subscribedUserId: string
  let inactiveUserId: string
  let systemUserId: string

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))

    const [subscribed] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'subscribed@example.com',
        name: 'Subscribed User',
        isActive: true,
        prefs: { notifications: { events: ['page:create', 'comment:new'] } }
      })
      .returning({ id: usersTable.id })
    subscribedUserId = subscribed!.id

    const [inactive] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'inactive@example.com',
        name: 'Inactive User',
        isActive: false,
        prefs: { notifications: { events: ['page:create'] } }
      })
      .returning({ id: usersTable.id })
    inactiveUserId = inactive!.id

    const [system] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'system@example.com',
        name: 'System Account',
        isActive: true,
        isSystem: true,
        prefs: { notifications: { events: ['page:create'] } }
      })
      .returning({ id: usersTable.id })
    systemUserId = system!.id
  })

  test('finds an active, non-system user subscribed to the event', async () => {
    const subscribers = await usersModel.listEmailSubscribers('page:create')
    const ids = subscribers.map((u) => u.id)
    assert.ok(ids.includes(subscribedUserId))
  })

  test('excludes an inactive user even if subscribed', async () => {
    const subscribers = await usersModel.listEmailSubscribers('page:create')
    const ids = subscribers.map((u) => u.id)
    assert.ok(!ids.includes(inactiveUserId))
  })

  test('excludes a system account even if subscribed', async () => {
    const subscribers = await usersModel.listEmailSubscribers('page:create')
    const ids = subscribers.map((u) => u.id)
    assert.ok(!ids.includes(systemUserId))
  })

  test('does not return a subscriber for an event they did not subscribe to', async () => {
    const subscribers = await usersModel.listEmailSubscribers('page:delete')
    const ids = subscribers.map((u) => u.id)
    assert.ok(!ids.includes(subscribedUserId))
  })

  test('an event nobody subscribed to returns an empty list', async () => {
    const subscribers = await usersModel.listEmailSubscribers('user:logout')
    assert.deepEqual(subscribers, [])
  })
})
