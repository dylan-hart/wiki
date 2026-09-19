import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

const USER_ID = '44444444-4444-4444-8444-444444444444'

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

describe('PUT /users/profile: aesthetic', () => {
  for (const value of ['site', 'ledger', 'cobalt']) {
    test(`accepts '${value}' and carries it into the patch unchanged`, async () => {
      const res = await asUser({ aesthetic: value })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(updateProfileCalls[0].patch, { aesthetic: value })
    })
  }

  test('rejects a value outside the enum before it ever reaches the model', async () => {
    const res = await asUser({ aesthetic: 'dark' })

    assert.equal(res.statusCode, 400)
    assert.equal(updateProfileCalls.length, 0)
  })

  test('answers with the saved value on the returned profile', async () => {
    const res = await asUser({ aesthetic: 'cobalt' })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().profile.aesthetic, 'cobalt')
  })
})

/**
 * `session: 'header'` parses a fresh object on every request, so it cannot show a mutation; a
 * session function returning the same mutable object can.
 */
describe('PUT /users/profile: aesthetic on the session', () => {
  test('copies the saved value onto req.session.user, the same as appearance', async () => {
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
        payload: { aesthetic: 'cobalt' }
      })

      assert.equal(res.statusCode, 200)
      assert.equal(sessionState.user.aesthetic, 'cobalt')
    } finally {
      await closeTestApp(sessionApp)
    }
  })
})
