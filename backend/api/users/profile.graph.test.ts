import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * `PUT /users/profile` carrying `graph` (OpenProject #2854): the knowledge graph view's five
 * persisted controls, saved and read back as one whole object.
 *
 * Mirrors `profile.aesthetic.test.ts`'s shape for the field this WP adds: the real
 * `UserProfileUpdate` schema (registered through `buildTestApp`'s default `schemas: 'all'`)
 * enum-validates every sub-key -- an out-of-enum value, or an unknown key, never reaches the model at
 * all (`additionalProperties: false`) -- and a successful save both hands the patch to
 * `models/users.ts#updateProfile` unchanged and copies the saved value onto `req.session.user`, the
 * same "session carries a copy of the preferences" contract `aesthetic`/`appearance` already have.
 */

const USER_ID = '55555555-5555-4555-8555-555555555555'

const VALID_GRAPH = {
  groupBy: 'tag',
  sizeBy: 'visits',
  count: 'unique',
  over: 'last6mo',
  clientTypes: ['browser', 'mcp']
}

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

describe('PUT /users/profile: graph', () => {
  test('accepts a full five-key object and carries it into the patch unchanged', async () => {
    const res = await asUser({ graph: VALID_GRAPH })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { graph: VALID_GRAPH })
  })

  test('accepts a partial object -- the route whitelists the whole key, not each sub-field', async () => {
    const res = await asUser({ graph: { groupBy: 'folder' } })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { graph: { groupBy: 'folder' } })
  })

  test('rejects a sub-value outside its enum before it ever reaches the model', async () => {
    const res = await asUser({ graph: { sizeBy: 'uniform' } })

    assert.equal(res.statusCode, 400)
    assert.equal(updateProfileCalls.length, 0)
  })

  test('silently drops an unknown sub-key, matching every other route in this codebase', async () => {
    // -> This instance's ajv is configured with the Fastify default `removeAdditional: true` (see
    //    `profile.notifications.test.ts`'s own version of this test): `additionalProperties: false`
    //    is what tells ajv there IS such a thing as an unknown property here, but the configured
    //    removal mode strips the property from the body rather than rejecting the request -- so an
    //    unknown key never reaches the model, but a request carrying only one alongside it is not a
    //    400.
    const res = await asUser({ graph: { notARealControl: true, groupBy: 'tag' } })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { graph: { groupBy: 'tag' } })
  })

  test('answers with the saved value on the returned profile', async () => {
    const res = await asUser({ graph: VALID_GRAPH })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().profile.graph, VALID_GRAPH)
  })
})

/**
 * `req.session.user.graph` -- what `/whoami` (and therefore a page load with no save in between)
 * actually serves -- separately from the response body above. `session: 'header'` re-parses a fresh
 * object from a header on every request, so it cannot show a mutation; a session **function**
 * returning the same mutable object across requests can (`test/fastify.ts`'s documented third seeding
 * form).
 */
describe('PUT /users/profile: graph on the session', () => {
  test('copies the saved value onto req.session.user, the same as aesthetic/appearance', async () => {
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
        payload: { graph: VALID_GRAPH }
      })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(sessionState.user.graph, VALID_GRAPH)
    } finally {
      await closeTestApp(sessionApp)
    }
  })
})
