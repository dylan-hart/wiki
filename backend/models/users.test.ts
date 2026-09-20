import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { users } from './users.ts'

function makeUser(overrides: Partial<any> = {}): any {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    hasAvatar: false,
    prefs: {},
    groups: [],
    ...overrides
  }
}

/**
 * Stand-in for `@fastify/session`'s `Session#regenerate()`, which replaces `req.session` wholesale
 * rather than mutating it. That reassignment is the whole point: it is what lets a test tell whether
 * `updateSession` awaited the regenerate before writing its fields.
 */
function makeReq(): any {
  const req: any = { session: { id: 'pre-login-session-id' } }
  req.session.regenerate = mock.fn(async () => {
    req.session = { id: 'post-login-session-id', regenerate: req.session.regenerate }
  })
  return req
}

describe('users.updateSession', () => {
  test('regenerates the session id before writing any authenticated state', async () => {
    const user = makeUser()
    const req = makeReq()
    const preLoginSession = req.session
    const regenerate = preLoginSession.regenerate

    await users.updateSession(user, req)

    assert.equal(regenerate.mock.callCount(), 1)
    assert.notEqual(req.session, preLoginSession, 'expected a new session object post-login')
    assert.notEqual(
      req.session.id,
      preLoginSession.id,
      'expected the post-login session id to differ from the pre-login one'
    )
    assert.equal(req.session.authenticated, true)
    assert.equal(preLoginSession.authenticated, undefined)
  })

  test('marks the session authenticated and copies the core user fields', async () => {
    const user = makeUser({
      hasAvatar: true,
      prefs: {
        timezone: 'America/New_York',
        dateFormat: 'YYYY-MM-DD',
        appearance: 'dark',
        aesthetic: 'cobalt',
        contentWidth: 'measured',
        cvd: 'none',
        locale: 'fr'
      }
    })
    const req = makeReq()

    await users.updateSession(user, req)

    assert.equal(req.session.authenticated, true)
    assert.deepEqual(req.session.user, {
      id: 'user-1',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      hasAvatar: true,
      avatarProviderUrl: null,
      timezone: 'America/New_York',
      dateFormat: 'YYYY-MM-DD',
      timeFormat: undefined,
      appearance: 'dark',
      aesthetic: 'cobalt',
      contentWidth: 'measured',
      cvd: 'none',
      locale: 'fr'
    })
  })

  test('carries avatarProviderUrl through onto the session when the row has one', async () => {
    const user = makeUser({ avatarProviderUrl: 'https://provider.example/photo.jpg' })
    const req = makeReq()

    await users.updateSession(user, req)

    assert.equal(req.session.user.avatarProviderUrl, 'https://provider.example/photo.jpg')
  })

  test('normalizes a missing avatarProviderUrl to null rather than undefined', async () => {
    const user = makeUser()
    const req = makeReq()

    await users.updateSession(user, req)

    assert.equal(req.session.user.avatarProviderUrl, null)
  })

  test('flattens permissions across every group the user belongs to', async () => {
    const user = makeUser({
      groups: [
        { id: 'group-a', permissions: ['read:pages', 'write:comments'] },
        { id: 'group-b', permissions: ['manage:users'] }
      ]
    })
    const req = makeReq()

    await users.updateSession(user, req)

    assert.deepEqual(
      new Set(req.session.permissions),
      new Set(['read:pages', 'write:comments', 'manage:users'])
    )
    assert.equal(req.session.permissions.length, 3)
  })

  test('deduplicates a permission granted by more than one group', async () => {
    const user = makeUser({
      groups: [
        { id: 'group-a', permissions: ['read:pages', 'manage:users'] },
        { id: 'group-b', permissions: ['manage:users', 'access:admin'] }
      ]
    })
    const req = makeReq()

    await users.updateSession(user, req)

    assert.deepEqual(
      new Set(req.session.permissions),
      new Set(['read:pages', 'manage:users', 'access:admin'])
    )
    assert.equal(req.session.permissions.length, 3)
  })

  test('carries group ids alongside their permissions, in membership order', async () => {
    const user = makeUser({
      groups: [
        { id: 'group-a', permissions: ['read:pages'] },
        { id: 'group-b', permissions: [] }
      ]
    })
    const req = makeReq()

    await users.updateSession(user, req)

    assert.deepEqual(req.session.groups, ['group-a', 'group-b'])
  })

  test('a user in no groups gets an authenticated session with nothing granted', async () => {
    const user = makeUser({ groups: [] })
    const req = makeReq()

    await users.updateSession(user, req)

    assert.equal(req.session.authenticated, true)
    assert.deepEqual(req.session.permissions, [])
    assert.deepEqual(req.session.groups, [])
  })
})

describe('users.reassignContent validation', () => {
  test('refuses to reassign a user onto themselves, without looking the target up', async (t) => {
    const getById = t.mock.method(users, 'getById', async () => {
      throw new Error('should not be called')
    })

    await assert.rejects(users.reassignContent('user-1', 'user-1'), /ERR_REASSIGN_SAME_USER/)
    assert.equal(getById.mock.callCount(), 0)
  })

  test('refuses a target user that does not exist', async (t) => {
    t.mock.method(users, 'getById', async () => null)

    await assert.rejects(users.reassignContent('user-1', 'user-2'), /ERR_INVALID_USER/)
  })

  test('refuses a target user that is a system account', async (t) => {
    t.mock.method(users, 'getById', async () => ({ id: 'user-2', isSystem: true }))

    await assert.rejects(users.reassignContent('user-1', 'user-2'), /ERR_REASSIGN_TARGET_IS_SYSTEM/)
  })
})

/**
 * A real round trip would only prove the returned value is correct, not that the column list sent to
 * the database actually shrank — hence spying on `CARDINAL.db.select` rather than querying. Not
 * pulling the avatar blob for a conditional request is the whole reason `getAvatarHash` exists.
 */
describe('getAvatarHash selection (pure unit, OpenProject #1849)', () => {
  let previousWiki: typeof globalThis.CARDINAL

  function stubSelect(row?: Record<string, unknown>) {
    const calls: Record<string, unknown>[] = []
    const chain: any = {}
    chain.from = mock.fn(() => chain)
    chain.where = mock.fn(() => chain)
    chain.limit = mock.fn(async () => (row ? [row] : []))
    const select = mock.fn((config: Record<string, unknown>) => {
      calls.push(config)
      return chain
    })
    return { select, calls }
  }

  beforeEach(() => {
    previousWiki = globalThis.CARDINAL
  })

  afterEach(() => {
    globalThis.CARDINAL = previousWiki
  })

  test('the emitted selection asks only for hash, never data', async () => {
    const { select, calls } = stubSelect({ hash: 'deadbeef' })
    globalThis.CARDINAL = { db: { select } } as unknown as typeof globalThis.CARDINAL
    const { users: usersModel } = await import('./users.ts')

    const hash = await usersModel.getAvatarHash('user-1')

    assert.equal(hash, 'deadbeef')
    assert.equal(calls.length, 1)
    const selectedKeys = Object.keys(calls[0]!)
    assert.deepEqual(selectedKeys, ['hash'])
  })

  test('returns null rather than throwing when no row matches', async () => {
    const { select } = stubSelect(undefined)
    globalThis.CARDINAL = { db: { select } } as unknown as typeof globalThis.CARDINAL
    const { users: usersModel } = await import('./users.ts')

    assert.equal(await usersModel.getAvatarHash('missing-user'), null)
  })
})
