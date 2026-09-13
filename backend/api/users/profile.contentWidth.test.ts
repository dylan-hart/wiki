import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * `PUT /users/profile` carrying `contentWidth` (Feature #3051, Task #3068).
 *
 * Mirrors `profile.aesthetic.test.ts`'s shape for the field this Task adds: the real
 * `UserProfileUpdate` schema (registered through `buildTestApp`'s default `schemas: 'all'`)
 * enum-validates the write side to `'site' | 'measured' | 'full'` -- an out-of-enum value never
 * reaches the model at all -- and a successful save both hands the patch to
 * `models/users.ts#updateProfile` unchanged and copies the saved value onto `req.session.user`, the
 * same "session carries a copy of the preferences" contract `aesthetic`/`appearance` already have.
 */

const USER_ID = '55555555-5555-4555-8555-555555555555'

let app: FastifyInstance
let updateProfileCalls: any[]

function storedProfile(overrides: Record<string, any> = {}) {
  return {
    id: USER_ID,
    name: 'Ada Lovelace',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    hasAvatar: false,
    location: '',
    jobTitle: '',
    pronouns: '',
    timezone: 'UTC',
    dateFormat: '',
    timeFormat: '12h',
    appearance: 'site',
    aesthetic: 'site',
    contentWidth: 'site',
    cvd: 'none',
    locale: '',
    ...overrides
  }
}

before(async () => {
  const wiki = {
    config: {},
    models: {
      sites: {
        getSiteByHostname: async () => null
      },
      users: {
        updateProfile: async (id: string, patch: any) => {
          updateProfileCalls.push({ id, patch })
          return storedProfile(patch)
        }
      }
    }
  }

  app = await buildTestApp({
    routes: usersRoutes,
    prefix: '/users',
    session: 'header',
    permissions: true,
    ajv: true,
    wiki
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  updateProfileCalls = []
})

function asUser(payload: Record<string, any>) {
  return app.inject({
    method: 'PUT',
    url: '/users/profile',
    headers: { 'x-test-session': JSON.stringify({ authenticated: true, user: { id: USER_ID } }) },
    payload
  })
}

describe('PUT /users/profile: contentWidth', () => {
  for (const value of ['site', 'measured', 'full']) {
    test(`accepts '${value}' and carries it into the patch unchanged`, async () => {
      const res = await asUser({ contentWidth: value })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(updateProfileCalls[0].patch, { contentWidth: value })
    })
  }

  test('rejects a value outside the enum before it ever reaches the model', async () => {
    const res = await asUser({ contentWidth: 'narrow' })

    assert.equal(res.statusCode, 400)
    assert.equal(updateProfileCalls.length, 0)
  })

  test('answers with the saved value on the returned profile', async () => {
    const res = await asUser({ contentWidth: 'full' })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().profile.contentWidth, 'full')
  })
})

/**
 * `req.session.user.contentWidth` -- what `/whoami` (and therefore a page load with no save in
 * between) actually serves -- separately from the response body above. `session: 'header'` re-parses
 * a fresh object from a header on every request, so it cannot show a mutation; a session **function**
 * returning the same mutable object across requests can (`test/fastify.ts`'s documented third seeding
 * form).
 */
describe('PUT /users/profile: contentWidth on the session', () => {
  test('copies the saved value onto req.session.user, the same as aesthetic', async () => {
    const sessionState: any = { authenticated: true, user: { id: USER_ID } }
    const sessionApp = await buildTestApp({
      routes: usersRoutes,
      prefix: '/users',
      session: () => sessionState,
      permissions: true,
      ajv: true,
      wiki: {
        config: {},
        models: {
          sites: { getSiteByHostname: async () => null },
          users: {
            updateProfile: async (_id: string, patch: any) => storedProfile(patch)
          }
        }
      }
    })

    try {
      const res = await sessionApp.inject({
        method: 'PUT',
        url: '/users/profile',
        payload: { contentWidth: 'measured' }
      })

      assert.equal(res.statusCode, 200)
      assert.equal(sessionState.user.contentWidth, 'measured')
    } finally {
      await closeTestApp(sessionApp)
    }
  })
})
