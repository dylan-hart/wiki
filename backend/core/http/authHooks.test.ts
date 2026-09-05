import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { permissionPreHandler } from './authHooks.ts'

/**
 * The route-permission `preHandler` was inline in `index.ts` until task A15 lifted it out, which is
 * what makes it testable at all: it is the single gate every `config.permissions` declaration in
 * `backend/api/` is enforced by, and its `req.apiKey` branch — a verified key standing in for a
 * session — had no coverage anywhere (the six hand-rolled replicas in the API test suites all drop
 * it, which is exactly the drift TEST-F2 records).
 *
 * Only GLOBAL permissions are decided here; see CLAUDE.md's Permissions section for why a page-rule
 * or site-scoped name can never be enforced through `config.permissions`.
 */

/** A stand-in for `FastifyReply` recording the two refusals this hook may send. */
function fakeReply() {
  const calls: { unauthorized: number; forbidden: number } = { unauthorized: 0, forbidden: 0 }
  const reply: any = {
    unauthorized() {
      calls.unauthorized++
      return reply
    },
    forbidden() {
      calls.forbidden++
      return reply
    }
  }
  return { reply: reply as FastifyReply, calls }
}

/** A stand-in for `FastifyRequest` carrying only what the hook reads. */
function fakeRequest(opts: {
  permissions?: unknown
  apiKey?: { permissions: string[] } | null
  session?: { authenticated?: boolean; permissions?: string[] } | null
}): FastifyRequest {
  return {
    routeOptions: { config: { permissions: opts.permissions } },
    apiKey: opts.apiKey ?? null,
    session: opts.session ?? undefined
  } as unknown as FastifyRequest
}

/** Runs the hook and reports whether it called `done()` and what it sent. */
function run(req: FastifyRequest) {
  const { reply, calls } = fakeReply()
  let doneCalls = 0
  permissionPreHandler(req, reply, () => {
    doneCalls++
  })
  return { doneCalls, ...calls }
}

describe('permissionPreHandler', () => {
  test('a route declaring no permissions passes straight through', () => {
    const res = run(fakeRequest({ permissions: undefined }))
    assert.deepEqual(res, { doneCalls: 1, unauthorized: 0, forbidden: 0 })
  })

  test('a route declaring an empty permission list passes straight through', () => {
    const res = run(fakeRequest({ permissions: [] }))
    assert.deepEqual(res, { doneCalls: 1, unauthorized: 0, forbidden: 0 })
  })

  test('an anonymous request to a guarded route is unauthorized', () => {
    const res = run(fakeRequest({ permissions: ['manage:users'], session: null }))
    assert.deepEqual(res, { doneCalls: 0, unauthorized: 1, forbidden: 0 })
  })

  /*
    OpenProject #2555's own fallout: a Users-group-only account genuinely holds an empty GLOBAL
    `permissions` list once page access lives entirely in rule `roles` rather than being (wrongly)
    duplicated onto this column too -- caught live by `e2e/tests/permissions.spec.js`, which
    expects visiting a globally-gated admin route to answer 403 Forbidden (the `/_error/
    unauthorized` screen) and instead got bounced to `/login` by the frontend's session-expiry
    interceptor reacting to a 401. An authenticated identity holding zero (or the wrong)
    permissions is forbidden, not unauthenticated -- only the absence of any verified identity at
    all (no key, no authenticated session) is.
  */
  test('an authenticated session holding no permissions is forbidden, not unauthorized', () => {
    const res = run(
      fakeRequest({
        permissions: ['manage:users'],
        session: { authenticated: true, permissions: [] }
      })
    )
    assert.deepEqual(res, { doneCalls: 0, unauthorized: 0, forbidden: 1 })
  })

  test('an authenticated session with no permissions array at all is forbidden, not unauthorized', () => {
    const res = run(
      fakeRequest({
        permissions: ['manage:users'],
        session: { authenticated: true }
      })
    )
    assert.deepEqual(res, { doneCalls: 0, unauthorized: 0, forbidden: 1 })
  })

  test('a session that is not authenticated is unauthorized even when it carries permissions', () => {
    const res = run(
      fakeRequest({
        permissions: ['manage:users'],
        session: { authenticated: false, permissions: ['manage:users'] }
      })
    )
    assert.deepEqual(res, { doneCalls: 0, unauthorized: 1, forbidden: 0 })
  })

  describe('the OR list', () => {
    test('holding any one of the listed permissions is allowed', () => {
      const res = run(
        fakeRequest({
          permissions: ['read:sites', 'manage:sites'],
          session: { authenticated: true, permissions: ['manage:sites'] }
        })
      )
      assert.deepEqual(res, { doneCalls: 1, unauthorized: 0, forbidden: 0 })
    })

    test('holding none of them is forbidden, not unauthorized', () => {
      const res = run(
        fakeRequest({
          permissions: ['read:sites', 'manage:sites'],
          session: { authenticated: true, permissions: ['read:users'] }
        })
      )
      assert.deepEqual(res, { doneCalls: 0, unauthorized: 0, forbidden: 1 })
    })
  })

  describe('a nested array is ANDed', () => {
    test('holding every permission of the nested entry is allowed', () => {
      const res = run(
        fakeRequest({
          permissions: [['manage:users', 'manage:groups']],
          session: { authenticated: true, permissions: ['manage:users', 'manage:groups'] }
        })
      )
      assert.deepEqual(res, { doneCalls: 1, unauthorized: 0, forbidden: 0 })
    })

    test('holding only part of the nested entry is forbidden', () => {
      const res = run(
        fakeRequest({
          permissions: [['manage:users', 'manage:groups']],
          session: { authenticated: true, permissions: ['manage:users'] }
        })
      )
      assert.deepEqual(res, { doneCalls: 0, unauthorized: 0, forbidden: 1 })
    })

    test('a nested entry ORs with its siblings', () => {
      const res = run(
        fakeRequest({
          permissions: ['read:sites', ['manage:users', 'manage:groups']],
          session: { authenticated: true, permissions: ['read:sites'] }
        })
      )
      assert.deepEqual(res, { doneCalls: 1, unauthorized: 0, forbidden: 0 })
    })
  })

  describe('manage:system', () => {
    test('bypasses a permission the caller does not otherwise hold', () => {
      const res = run(
        fakeRequest({
          permissions: ['manage:sites'],
          session: { authenticated: true, permissions: ['manage:system'] }
        })
      )
      assert.deepEqual(res, { doneCalls: 1, unauthorized: 0, forbidden: 0 })
    })

    test('bypasses a nested AND entry too', () => {
      const res = run(
        fakeRequest({
          permissions: [['manage:users', 'manage:groups']],
          session: { authenticated: true, permissions: ['manage:system'] }
        })
      )
      assert.deepEqual(res, { doneCalls: 1, unauthorized: 0, forbidden: 0 })
    })
  })

  describe('a verified API key stands in for a session', () => {
    test('its permissions are what the route is checked against, with no session at all', () => {
      const res = run(
        fakeRequest({
          permissions: ['manage:sites'],
          apiKey: { permissions: ['manage:sites'] },
          session: null
        })
      )
      assert.deepEqual(res, { doneCalls: 1, unauthorized: 0, forbidden: 0 })
    })

    test('a key holding none of the listed permissions is forbidden', () => {
      const res = run(
        fakeRequest({
          permissions: ['manage:sites'],
          apiKey: { permissions: ['read:sites'] },
          session: null
        })
      )
      assert.deepEqual(res, { doneCalls: 0, unauthorized: 0, forbidden: 1 })
    })

    // -> Same distinction as the session case above: a verified key with an empty permissions
    //    array is a real, valid identity (e.g. issued for a group with only page-rule access) that
    //    simply doesn't hold what this route asks for -- forbidden, not unauthorized.
    test('a key carrying no permissions at all is forbidden, not unauthorized', () => {
      const res = run(
        fakeRequest({
          permissions: ['manage:sites'],
          apiKey: { permissions: [] },
          session: null
        })
      )
      assert.deepEqual(res, { doneCalls: 0, unauthorized: 0, forbidden: 1 })
    })

    test('the key is preferred over an authenticated session that would have passed', () => {
      const res = run(
        fakeRequest({
          permissions: ['manage:sites'],
          apiKey: { permissions: ['read:sites'] },
          session: { authenticated: true, permissions: ['manage:sites'] }
        })
      )
      assert.deepEqual(res, { doneCalls: 0, unauthorized: 0, forbidden: 1 })
    })

    test('a key holding manage:system bypasses the check like a session would', () => {
      const res = run(
        fakeRequest({
          permissions: ['manage:sites'],
          apiKey: { permissions: ['manage:system'] },
          session: null
        })
      )
      assert.deepEqual(res, { doneCalls: 1, unauthorized: 0, forbidden: 0 })
    })
  })
})
