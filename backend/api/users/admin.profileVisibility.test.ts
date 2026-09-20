import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

let app: FastifyInstance
let saveToDb: ReturnType<typeof mock.fn>

before(async () => {
  app = await buildTestApp({
    routes: usersRoutes,
    prefix: '/users',
    session: 'header',
    permissions: true,
    ajv: true,
    wiki: { config: {}, configSvc: { saveToDb: async () => true } }
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  CARDINAL.config.profileVisibility = { forcedPublicFields: [], guestsMayView: false }
  saveToDb = mock.fn(async () => true)
  CARDINAL.configSvc.saveToDb = saveToDb as any
})

function request(method: 'GET' | 'PUT', permissions: string, payload?: Record<string, any>) {
  return app.inject({
    method,
    url: '/users/profile-visibility',
    headers: { 'x-test-permissions': permissions },
    payload
  })
}

describe('GET /users/profile-visibility', () => {
  test('answers the stored settings to a reader of users', async () => {
    CARDINAL.config.profileVisibility = { forcedPublicFields: ['jobTitle'], guestsMayView: true }

    const res = await request('GET', 'read:users')

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { forcedPublicFields: ['jobTitle'], guestsMayView: true })
  })

  test('answers the defaults when nothing was ever stored', async () => {
    delete CARDINAL.config.profileVisibility

    const res = await request('GET', 'read:users')

    assert.deepEqual(res.json(), { forcedPublicFields: [], guestsMayView: false })
  })

  test('is refused to somebody holding neither users permission', async () => {
    const res = await request('GET', 'read:pages')

    assert.equal(res.statusCode, 403)
  })
})

describe('PUT /users/profile-visibility', () => {
  test('saves the forced list and the guest switch through saveToDb', async () => {
    const res = await request('PUT', 'manage:users', {
      forcedPublicFields: ['location', 'pronouns'],
      guestsMayView: true
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(saveToDb.mock.calls[0].arguments, [['profileVisibility']])
    assert.deepEqual(CARDINAL.config.profileVisibility, {
      forcedPublicFields: ['location', 'pronouns'],
      guestsMayView: true
    })
  })

  test('leaves the setting it was not sent alone', async () => {
    CARDINAL.config.profileVisibility = { forcedPublicFields: ['location'], guestsMayView: true }

    const res = await request('PUT', 'manage:users', { guestsMayView: false })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(CARDINAL.config.profileVisibility, {
      forcedPublicFields: ['location'],
      guestsMayView: false
    })
  })

  test('can empty the forced list', async () => {
    CARDINAL.config.profileVisibility = { forcedPublicFields: ['location'], guestsMayView: false }

    const res = await request('PUT', 'manage:users', { forcedPublicFields: [] })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(CARDINAL.config.profileVisibility.forcedPublicFields, [])
  })

  for (const bad of [['email'], ['location', 'passwordHash'], ['location', 'location']]) {
    test(`rejects a forced list of ${JSON.stringify(bad)}: only About Me fields, once each`, async () => {
      const res = await request('PUT', 'manage:users', { forcedPublicFields: bad })

      assert.equal(res.statusCode, 400)
      assert.equal(saveToDb.mock.callCount(), 0)
      assert.deepEqual(CARDINAL.config.profileVisibility.forcedPublicFields, [])
    })
  }

  test('rejects an empty body', async () => {
    const res = await request('PUT', 'manage:users', {})

    assert.equal(res.statusCode, 400)
    assert.equal(saveToDb.mock.callCount(), 0)
  })

  test('answers 500 and rolls the in-memory settings back when saving fails', async () => {
    CARDINAL.configSvc.saveToDb = mock.fn(async () => false) as any

    const res = await request('PUT', 'manage:users', { guestsMayView: true })

    assert.equal(res.statusCode, 500)
    assert.deepEqual(CARDINAL.config.profileVisibility, {
      forcedPublicFields: [],
      guestsMayView: false
    })
  })

  test('is refused to a reader who cannot manage users', async () => {
    const res = await request('PUT', 'read:users', { guestsMayView: true })

    assert.equal(res.statusCode, 403)
  })
})
