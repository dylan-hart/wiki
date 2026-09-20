import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { toPublicProfile } from '../../models/users.ts'

const VIEWER_ID = '44444444-4444-4444-8444-444444444444'
const TARGET_ID = '55555555-5555-4555-8555-555555555555'
const INACTIVE_ID = '66666666-6666-4666-8666-666666666666'
const SYSTEM_ID = '77777777-7777-4777-8777-777777777777'

const accounts: Record<string, any> = {}
let app: FastifyInstance

function account(overrides: Record<string, any> = {}) {
  return {
    id: TARGET_ID,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    hasAvatar: false,
    avatarProviderUrl: null,
    isActive: true,
    isSystem: false,
    meta: { location: 'London', jobTitle: 'Analyst', pronouns: 'she/her' },
    prefs: { publicFields: ['jobTitle'] },
    ...overrides
  }
}

before(async () => {
  accounts[TARGET_ID] = account()
  accounts[INACTIVE_ID] = account({ id: INACTIVE_ID, isActive: false })
  accounts[SYSTEM_ID] = account({ id: SYSTEM_ID, isSystem: true })

  app = await buildTestApp({
    routes: usersRoutes,
    prefix: '/users',
    session: 'header',
    permissions: true,
    ajv: true,
    wiki: {
      config: { profileVisibility: { forcedPublicFields: [], guestsMayView: false } },
      models: {
        users: {
          getPublicProfile: async (id: string) => {
            const row = accounts[id]
            return row ? toPublicProfile(row) : null
          }
        }
      }
    }
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  CARDINAL.config.profileVisibility = { forcedPublicFields: [], guestsMayView: false }
})

function get(id: string, signedIn = true) {
  return app.inject({
    method: 'GET',
    url: `/users/${id}/profile`,
    headers: signedIn
      ? {
          'x-test-session': JSON.stringify({ authenticated: true, user: { id: VIEWER_ID } })
        }
      : {}
  })
}

describe('GET /users/:userId/profile', () => {
  test("returns only the fields the user made public, and the identity's display parts", async () => {
    const res = await get(TARGET_ID)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      id: TARGET_ID,
      name: 'Ada Lovelace',
      hasAvatar: false,
      avatarProviderUrl: null,
      fields: { jobTitle: 'Analyst' }
    })
  })

  test('adds the admin-forced fields to what the user chose', async () => {
    CARDINAL.config.profileVisibility.forcedPublicFields = ['location']

    const res = await get(TARGET_ID)

    assert.deepEqual(res.json().fields, { location: 'London', jobTitle: 'Analyst' })
  })

  test('leaves hidden fields and the email out of the body entirely', async () => {
    const res = await get(TARGET_ID)

    assert.equal(res.body.includes('London'), false)
    assert.equal(res.body.includes('she/her'), false)
    assert.equal(res.body.includes('ada@example.com'), false)
    assert.equal('email' in res.json(), false)
  })

  test('does not surface a forced field the user left empty', async () => {
    CARDINAL.config.profileVisibility.forcedPublicFields = ['pronouns']
    accounts[TARGET_ID] = account({ meta: { location: 'London', jobTitle: 'Analyst' } })

    const res = await get(TARGET_ID)

    assert.deepEqual(res.json().fields, { jobTitle: 'Analyst' })
    accounts[TARGET_ID] = account()
  })

  test('answers 401 to a guest by default', async () => {
    const res = await get(TARGET_ID, false)

    assert.equal(res.statusCode, 401)
  })

  test('answers 401 to a session that is not authenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/users/${TARGET_ID}/profile`,
      headers: { 'x-test-session': JSON.stringify({ authenticated: false }) }
    })

    assert.equal(res.statusCode, 401)
  })

  test('lets a guest in once an administrator allows it, with the same redaction', async () => {
    CARDINAL.config.profileVisibility.guestsMayView = true

    const res = await get(TARGET_ID, false)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().fields, { jobTitle: 'Analyst' })
    assert.equal(res.body.includes('ada@example.com'), false)
  })

  test('still answers 401 to a guest when the setting was never stored', async () => {
    delete CARDINAL.config.profileVisibility

    const res = await get(TARGET_ID, false)

    assert.equal(res.statusCode, 401)
  })

  test('refuses an inactive account', async () => {
    const res = await get(INACTIVE_ID)

    assert.equal(res.statusCode, 404)
  })

  test('refuses a system account, even when guests may view', async () => {
    CARDINAL.config.profileVisibility.guestsMayView = true

    const res = await get(SYSTEM_ID, false)

    assert.equal(res.statusCode, 404)
  })

  test('answers 404 for an unknown user, the same as an inactive one', async () => {
    const res = await get('88888888-8888-4888-8888-888888888888')

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().message, (await get(INACTIVE_ID)).json().message)
  })

  test('rejects an id that is not a uuid before it reaches the model', async () => {
    const res = await get('not-a-uuid')

    assert.equal(res.statusCode, 400)
  })

  test('is not cacheable', async () => {
    const res = await get(TARGET_ID)

    assert.match(String(res.headers['cache-control']), /no-store|no-cache/)
  })
})
