import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * `PUT /users/profile` carrying `iconPicker`: the icon picker's one persisted control, its set
 * filter (`IconPickerDialog.vue`'s `state.setFilter`).
 *
 * Mirrors `profile.graph.test.ts`'s shape for this field: the real `UserProfileUpdate` schema
 * (registered through `buildTestApp`'s default `schemas: 'all'`) rejects an unknown sub-key
 * (`additionalProperties: false`) before it ever reaches the model, and a successful save both hands
 * the patch to `models/users.ts#updateProfile` unchanged and copies the saved value onto
 * `req.session.user`, the same "session carries a copy of the preferences" contract every other
 * profile pref has.
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

describe('PUT /users/profile: iconPicker', () => {
  test('accepts a set filter and carries it into the patch unchanged', async () => {
    const res = await asUser({ iconPicker: { set: 'tabler' } })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { iconPicker: { set: 'tabler' } })
  })

  test('accepts an empty string, clearing back to "every enabled set"', async () => {
    const res = await asUser({ iconPicker: { set: '' } })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { iconPicker: { set: '' } })
  })

  test('silently drops an unknown sub-key, matching every other route in this codebase', async () => {
    const res = await asUser({ iconPicker: { notARealControl: true, set: 'mdi' } })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { iconPicker: { set: 'mdi' } })
  })

  test('answers with the saved value on the returned profile', async () => {
    const res = await asUser({ iconPicker: { set: 'tabler' } })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().profile.iconPicker, { set: 'tabler' })
  })
})

/**
 * `req.session.user.iconPicker` -- what `/whoami` actually serves -- separately from the response
 * body above. `session: 'header'` re-parses a fresh object from a header on every request, so it
 * cannot show a mutation; a session **function** returning the same mutable object across requests
 * can (`test/fastify.ts`'s documented third seeding form).
 */
describe('PUT /users/profile: iconPicker on the session', () => {
  test('copies the saved value onto req.session.user, the same as graph/aesthetic/appearance', async () => {
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
        payload: { iconPicker: { set: 'tabler' } }
      })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(sessionState.user.iconPicker, { set: 'tabler' })
    } finally {
      await closeTestApp(sessionApp)
    }
  })
})
