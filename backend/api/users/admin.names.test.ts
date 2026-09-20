import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * What this guards is the separation: these routes carry `firstName`/`lastName` to the model and
 * decide nothing about them -- `models/users.ts` owns the derive-unless-authored rule.
 */

const LOCAL_AUTH_ID = '00000000-0000-4000-8000-000000000001'
const NEW_USER_ID = '11111111-1111-4111-8111-111111111111'
const EXISTING_USER_ID = '22222222-2222-4222-8222-222222222222'

let app: FastifyInstance
let createUserCalls: any[]
let updateUserCalls: any[]

before(async () => {
  const wiki = {
    data: { systemIds: { localAuthId: LOCAL_AUTH_ID } },
    models: {
      users: {
        getByEmail: async () => null,
        getById: async () => ({
          id: EXISTING_USER_ID,
          email: 'ada@example.com',
          isSystem: false
        }),
        createUser: async (args: any) => {
          createUserCalls.push(args)
          return NEW_USER_ID
        },
        applyUserUpdate: async (id: string, args: any) => {
          updateUserCalls.push({ id, patch: args.patch })
          return true
        },
        getUserGroupIds: async () => []
      },
      auditLog: { record: async () => {} },
      groups: {
        hasUnknownGroupIds: async (ids: string[]) => ids.length > 0,
        holdsSystemPermission: () => false,
        assertMembershipChangeAllowed: async () => {},
        userHoldsSystemPermission: async () => false
      },
      mail: { isConfigured: () => true, sendWelcomeEmail: async () => {} },
      sessions: { invalidateUserSessions: async () => {} }
    }
  }

  app = await buildTestApp({ routes: usersRoutes, wiki, ajv: true })
})

after(() => closeTestApp(app))

beforeEach(() => {
  createUserCalls = []
  updateUserCalls = []
})

describe('POST /users: the two authored name halves', () => {
  test('accepts halves with no name at all, and hands all three to createUser as given', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        password: 'a-long-password'
      }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(createUserCalls.length, 1)
    assert.equal(createUserCalls[0].firstName, 'Ada')
    assert.equal(createUserCalls[0].lastName, 'Lovelace')
    // -> Undefined, not the derived string: a name passed here would make the account born
    //    authored, and it would stop tracking later edits to its halves.
    assert.equal(createUserCalls[0].name, undefined)
  })

  test('accepts a mononym: a first name alone, with no surname fabricated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: { firstName: 'Prince', email: 'prince@example.com', password: 'a-long-password' }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(createUserCalls[0].firstName, 'Prince')
    assert.equal(createUserCalls[0].lastName, undefined)
  })

  test('still accepts an explicitly authored name on its own, for an API caller that has one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: { name: 'Ada Lovelace', email: 'ada@example.com', password: 'a-long-password' }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(createUserCalls[0].name, 'Ada Lovelace')
  })

  test('refuses a create that would name the account nothing at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: { email: 'nobody@example.com', password: 'a-long-password' }
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error, 'userCreateInvalidName')
    assert.equal(createUserCalls.length, 0)
  })

  test('refuses a half carrying the characters a name has always refused', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        firstName: 'Ada',
        lastName: '<script>',
        email: 'ada@example.com',
        password: 'a-long-password'
      }
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error, 'userCreateInvalidName')
    assert.equal(createUserCalls.length, 0)
  })
})

describe('PUT /users/:userId: the two authored name halves', () => {
  test('carries all three name fields into the patch, unchanged and undecided', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/${EXISTING_USER_ID}`,
      payload: { name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace' }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(updateUserCalls.length, 1)
    assert.deepEqual(updateUserCalls[0].patch, {
      name: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace'
    })
    // -> The route must not decide authorship: `updateUser` reads the stored row to answer that,
    //    and a `nameLocallyEdited` set here would pre-empt it.
    assert.equal('nameLocallyEdited' in updateUserCalls[0].patch, false)
  })

  test('a halves-only patch carries no name, leaving the model to re-derive it', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/${EXISTING_USER_ID}`,
      payload: { firstName: 'Augusta', lastName: 'King' }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateUserCalls[0].patch, { firstName: 'Augusta', lastName: 'King' })
  })

  test('an empty last name is a real value, not an omission', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/${EXISTING_USER_ID}`,
      payload: { firstName: 'Prince', lastName: '' }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateUserCalls[0].patch, { firstName: 'Prince', lastName: '' })
  })
})
