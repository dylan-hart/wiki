import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

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

const row = { mode: 'exclude', type: 'path', value: 'departments/x' }

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

function asUser(payload: Record<string, any>) {
  return app.inject({
    method: 'PUT',
    url: '/users/profile',
    headers: { 'x-test-session': JSON.stringify({ authenticated: true, user: { id: USER_ID } }) },
    payload
  })
}

describe('PUT /users/profile: searchFilters', () => {
  test('accepts rows and carries them into the patch unchanged', async () => {
    const res = await asUser({ searchFilters: [row] })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { searchFilters: [row] })
    assert.deepEqual(res.json().profile.searchFilters, [row])
  })

  test('accepts an empty array, which clears the list', async () => {
    const res = await asUser({ searchFilters: [] })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { searchFilters: [] })
  })

  test('rejects an unknown mode, type, or a creator/author type', async () => {
    for (const bad of [
      { ...row, mode: 'require' },
      { ...row, type: 'creator' },
      { ...row, type: 'author' }
    ]) {
      const res = await asUser({ searchFilters: [bad] })
      assert.equal(res.statusCode, 400)
    }
    assert.equal(updateProfileCalls.length, 0)
  })

  test('rejects a missing, empty or oversized value', async () => {
    for (const bad of [
      { mode: 'include', type: 'tag' },
      { ...row, value: '' },
      { ...row, value: 'a'.repeat(513) }
    ]) {
      const res = await asUser({ searchFilters: [bad] })
      assert.equal(res.statusCode, 400)
    }
    assert.equal(updateProfileCalls.length, 0)
  })

  test('rejects more than the maximum number of rows', async () => {
    const res = await asUser({ searchFilters: Array(21).fill(row) })

    assert.equal(res.statusCode, 400)
    assert.equal(updateProfileCalls.length, 0)
  })

  test('rejects a non-array', async () => {
    const res = await asUser({ searchFilters: row })

    assert.equal(res.statusCode, 400)
  })
})

describe('PUT /users/profile: searchFilters on the session', () => {
  test('copies the saved rows onto req.session.user', async () => {
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
          users: { updateProfile: async (_id: string, patch: any) => storedProfile(patch) }
        }
      }
    })

    try {
      const res = await sessionApp.inject({
        method: 'PUT',
        url: '/users/profile',
        payload: { searchFilters: [row] }
      })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(sessionState.user.searchFilters, [row])
    } finally {
      await closeTestApp(sessionApp)
    }
  })
})
