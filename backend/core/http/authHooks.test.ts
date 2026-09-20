import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { permissionPreHandler } from './authHooks.ts'

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
    A Users-group-only account genuinely holds an empty GLOBAL `permissions` list. A 401 for it
    would have the frontend's session-expiry interceptor bounce the reader to `/login`.
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

    // -> Still a verified identity: e.g. a key issued for a group with only page-rule access.
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
