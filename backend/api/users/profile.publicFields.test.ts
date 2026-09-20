import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

const USER_ID = '99999999-9999-4999-8999-999999999999'

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
    publicFields: [],
    forcedPublicFields: ['location'],
    ...overrides
  }
}

before(async () => {
  app = await buildTestApp({
    routes: usersRoutes,
    prefix: '/users',
    session: 'header',
    permissions: true,
    ajv: true,
    wiki: {
      config: {},
      models: {
        sites: { getSiteByHostname: async () => null },
        users: {
          getProfile: async () => storedProfile({ publicFields: ['pronouns'] }),
          updateProfile: async (id: string, patch: any) => {
            updateProfileCalls.push({ id, patch })
            return storedProfile(patch)
          }
        }
      }
    }
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  updateProfileCalls = []
})

function put(payload: Record<string, any>) {
  return app.inject({
    method: 'PUT',
    url: '/users/profile',
    headers: { 'x-test-session': JSON.stringify({ authenticated: true, user: { id: USER_ID } }) },
    payload
  })
}

describe('PUT /users/profile: publicFields', () => {
  test('carries the list into the patch unchanged', async () => {
    const res = await put({ publicFields: ['location', 'pronouns'] })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { publicFields: ['location', 'pronouns'] })
    assert.deepEqual(res.json().profile.publicFields, ['location', 'pronouns'])
  })

  test('accepts an empty list, which hides every field the user controls', async () => {
    const res = await put({ publicFields: [] })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { publicFields: [] })
  })

  for (const bad of [['email'], ['location', 'password'], ['location', 'location']]) {
    test(`rejects ${JSON.stringify(bad)} before it reaches the model`, async () => {
      const res = await put({ publicFields: bad })

      assert.equal(res.statusCode, 400)
      assert.equal(updateProfileCalls.length, 0)
    })
  }
})

describe('GET /users/profile: publicFields', () => {
  test("serves the user's own list and the admin-forced list separately", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users/profile',
      headers: { 'x-test-session': JSON.stringify({ authenticated: true, user: { id: USER_ID } }) }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().publicFields, ['pronouns'])
    assert.deepEqual(res.json().forcedPublicFields, ['location'])
  })
})
