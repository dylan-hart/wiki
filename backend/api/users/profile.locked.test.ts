import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

const USER_ID = '55555555-5555-4555-8555-555555555555'

let app: FastifyInstance
let updateProfileCalls: any[]
let profileFeature: boolean | undefined

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
        sites: {
          getSiteByHostname: async () => ({
            config: { features: profileFeature === undefined ? {} : { profile: profileFeature } }
          })
        },
        users: {
          updateProfile: async (id: string, patch: any) => {
            updateProfileCalls.push({ id, patch })
            return { id: USER_ID, name: 'Ada Lovelace', timezone: 'UTC', ...patch }
          }
        }
      }
    }
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  updateProfileCalls = []
  profileFeature = false
})

function put(payload: Record<string, any>) {
  return app.inject({
    method: 'PUT',
    url: '/users/profile',
    headers: { 'x-test-session': JSON.stringify({ authenticated: true, user: { id: USER_ID } }) },
    payload
  })
}

describe('PUT /users/profile on a site with profile editing locked', () => {
  const preferences: Array<[string, any]> = [
    ['timezone', 'Europe/London'],
    ['dateFormat', 'YYYY-MM-DD'],
    ['timeFormat', '24h'],
    ['appearance', 'dark'],
    ['aesthetic', 'cobalt'],
    ['contentWidth', 'full'],
    ['cvd', 'deuteranopia'],
    ['locale', 'fr']
  ]

  for (const [field, value] of preferences) {
    test(`accepts ${field}`, async () => {
      const res = await put({ [field]: value })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(updateProfileCalls[0].patch, { [field]: value })
    })
  }

  test('accepts every preference in a single body', async () => {
    const body = Object.fromEntries(preferences)
    const res = await put(body)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, body)
  })

  for (const field of ['name', 'firstName', 'lastName', 'location', 'jobTitle', 'pronouns']) {
    test(`refuses ${field} with 403 and writes nothing`, async () => {
      const res = await put({ [field]: 'Someone' })

      assert.equal(res.statusCode, 403)
      assert.equal(res.json().message, 'Profile editing is disabled on this site.')
      assert.equal(updateProfileCalls.length, 0)
    })
  }

  test('refuses a body mixing an identity field with a preference, applying neither', async () => {
    const res = await put({ name: 'Someone', appearance: 'dark' })

    assert.equal(res.statusCode, 403)
    assert.equal(updateProfileCalls.length, 0)
  })
})

describe('PUT /users/profile on a site with profile editing enabled', () => {
  for (const feature of [true, undefined]) {
    test(`still accepts identity fields (features.profile ${feature})`, async () => {
      profileFeature = feature
      const res = await put({ name: 'Someone', appearance: 'dark' })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(updateProfileCalls[0].patch, { name: 'Someone', appearance: 'dark' })
    })
  }
})
