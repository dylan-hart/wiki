import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { users } from './users.ts'

/**
 * `updateSession` is the one place a login turns a user row into session state — permissions
 * flattened across every group the user belongs to, and the group ids kept alongside them since
 * navigation is filtered per group. It touches neither `WIKI` nor the database, so this is a pure
 * unit test: no fixture from `test/db.ts` needed.
 *
 * Task 2115 / WP 2105 §4: `updateSession` also has to regenerate the session id before writing the
 * authenticated state, closing session fixation. `makeReq()`'s stub session mimics the one load-
 * bearing thing the real `@fastify/session#regenerate()` does that matters here — reassigning
 * `req.session` to a brand-new object with a fresh id (`node_modules/@fastify/session/lib/
 * session.js`'s own `regenerate()` does `this[requestKey].session = session` inside its store
 * callback) — so a test can tell whether `updateSession` awaited it before proceeding to set fields
 * on what is, post-await, a different object than the one it started with.
 */

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
 * Stand-in for `@fastify/session`'s `Session#regenerate()` (`lib/session.js`): records that it was
 * called, then swaps `req.session` for a fresh object carrying only a new `id` — same shape the real
 * store does by replacing `this[requestKey].session` with a brand-new `Session` instance whose id
 * differs from the one it started with.
 */
function makeReq(): any {
  const req: any = { session: { id: 'pre-login-session-id' } }
  req.session.regenerate = mock.fn(async () => {
    // -> A fresh object, not a mutation of the old one — matches the real plugin reassigning
    //    `req.session` wholesale, and is what lets a test tell the two apart by reference/id.
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
    // -> Landed on the regenerated session, not stranded on the discarded pre-login one
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
      timezone: 'America/New_York',
      dateFormat: 'YYYY-MM-DD',
      timeFormat: undefined,
      appearance: 'dark',
      aesthetic: 'cobalt',
      cvd: 'none',
      locale: 'fr'
    })
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

/**
 * `reassignContent`'s three refusals (same user, unknown target, target is a system account) all run
 * before the method ever opens its transaction, off nothing but `getById()`'s return value — so they
 * are tested by mocking that one collaborator, the same way `login.loginTFA`'s suite above mocks its
 * own collaborators, rather than paying for a database connection to prove a branch that never issues
 * a query.
 */
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
 * OpenProject #1849: `getAvatarHash` exists specifically so a conditional avatar request never pulls
 * the blob out of the database. A real Postgres round trip only proves the returned value is correct,
 * not that the column list sent to it actually shrank — so this spies on `WIKI.db.select` instead,
 * following the precedent set by `models/pages.test.ts`'s `getPage selection (pure unit, OpenProject
 * #1834)` describe block.
 */
describe('getAvatarHash selection (pure unit, OpenProject #1849)', () => {
  let previousWiki: typeof globalThis.WIKI

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
    previousWiki = globalThis.WIKI
  })

  afterEach(() => {
    globalThis.WIKI = previousWiki
  })

  test('the emitted selection asks only for hash, never data', async () => {
    const { select, calls } = stubSelect({ hash: 'deadbeef' })
    globalThis.WIKI = { db: { select } } as unknown as typeof globalThis.WIKI
    const { users: usersModel } = await import('./users.ts')

    const hash = await usersModel.getAvatarHash('user-1')

    assert.equal(hash, 'deadbeef')
    assert.equal(calls.length, 1)
    const selectedKeys = Object.keys(calls[0]!)
    assert.deepEqual(selectedKeys, ['hash'])
  })

  test('returns null rather than throwing when no row matches', async () => {
    const { select } = stubSelect(undefined)
    globalThis.WIKI = { db: { select } } as unknown as typeof globalThis.WIKI
    const { users: usersModel } = await import('./users.ts')

    assert.equal(await usersModel.getAvatarHash('missing-user'), null)
  })
})
