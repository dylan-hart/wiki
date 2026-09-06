import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * `PUT /users/profile` carrying the two authored name halves (Feature #2608, Task #2642).
 *
 * The claim under test is the same one `admin.names.test.ts` makes for the admin routes, from the
 * self-service side: the route validates the characters a name refuses and then hands all three
 * fields to `models/users.ts#updateProfile` unchanged. Deciding whether a submitted `name` counts as
 * authoring it belongs to `updateUser` alone; a route that pre-empted that would be the exact
 * duplication Feature #2608's one-owner rule exists to prevent.
 *
 * The `UserProfileUpdate` schema this exercises is registered through `buildTestApp`'s default
 * `schemas: 'all'`, so a field missing from it would surface here as a stripped payload rather than
 * silently passing.
 */

const USER_ID = '33333333-3333-4333-8333-333333333333'

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
    cvd: 'none',
    locale: '',
    ...overrides
  }
}

before(async () => {
  const wiki = {
    config: {},
    models: {
      // -> `isProfileEditable` resolves the request hostname through the sites model; no site
      //    resolving is the documented "editing enabled" fallback, and what a single-site instance
      //    behaves like.
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

describe('PUT /users/profile: the two authored name halves', () => {
  test('carries all three name fields into the patch, deciding nothing about them', async () => {
    const res = await asUser({ name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace' })

    assert.equal(res.statusCode, 200)
    assert.equal(updateProfileCalls.length, 1)
    assert.deepEqual(updateProfileCalls[0].patch, {
      name: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace'
    })
  })

  test('a halves-only save carries no name, leaving the model to re-derive it', async () => {
    const res = await asUser({ firstName: 'Augusta', lastName: 'King' })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { firstName: 'Augusta', lastName: 'King' })
  })

  test('an empty last name is a real value, not an omission', async () => {
    const res = await asUser({ firstName: 'Prince', lastName: '' })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { firstName: 'Prince', lastName: '' })
  })

  test('answers with the profile the model returned, halves included', async () => {
    const res = await asUser({ firstName: 'Augusta', lastName: 'King' })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().profile.firstName, 'Augusta')
    assert.equal(res.json().profile.lastName, 'King')
  })

  test('refuses a half carrying the characters a name has always refused', async () => {
    const res = await asUser({ firstName: 'Ada', lastName: '<script>' })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error, 'userProfileInvalidName')
    assert.equal(updateProfileCalls.length, 0)
  })

  test('an empty half is not treated as invalid: emptiness is how a mononym is expressed', async () => {
    const res = await asUser({ lastName: '' })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { lastName: '' })
  })
})
