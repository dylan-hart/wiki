import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { CustomError } from '../../helpers/common.ts'
import { normalizeHandle } from '../../models/users.ts'

const USER_ID = '33333333-3333-4333-8333-333333333333'
const TAKEN = 'taken'

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
    handle: null,
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
      sites: {
        getSiteByHostname: async () => null
      },
      users: {
        updateProfile: async (id: string, patch: any) => {
          updateProfileCalls.push({ id, patch })
          const handle = patch.handle === undefined ? null : normalizeHandle(patch.handle)
          if (handle?.toLowerCase() === TAKEN) {
            throw new CustomError('userHandleTaken', 'That handle is already taken.', 409)
          }
          return storedProfile({ handle })
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

describe('PUT /users/profile: handle', () => {
  test('carries a handle into the patch and answers with it on the profile', async () => {
    const res = await asUser({ handle: 'ada.l' })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { handle: 'ada.l' })
    assert.equal(res.json().profile.handle, 'ada.l')
  })

  test('an empty string is a real value that clears the handle', async () => {
    const res = await asUser({ handle: '' })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateProfileCalls[0].patch, { handle: '' })
    assert.equal(res.json().profile.handle, null)
  })

  test('a handle already taken answers 409 with the error text', async () => {
    const res = await asUser({ handle: 'Taken' })

    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error, 'userHandleTaken')
    assert.equal(res.json().message, 'That handle is already taken.')
  })

  test('an invalid handle answers 400 with the error text', async () => {
    const res = await asUser({ handle: 'no spaces' })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error, 'userHandleInvalid')
    assert.match(res.json().message, /only letters, digits, dots, underscores and hyphens/)
  })

  test('a handle over the length bound is refused by the schema before the model', async () => {
    const res = await asUser({ handle: 'a'.repeat(33) })

    assert.equal(res.statusCode, 400)
    assert.equal(updateProfileCalls.length, 0)
  })
})
