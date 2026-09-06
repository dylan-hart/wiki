import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * `POST /` and `PUT /:userId` carrying the two authored name halves (Feature #2608, Task #2642).
 *
 * What this file is actually guarding is the SEPARATION: these routes carry `firstName`/`lastName`
 * to the model and decide nothing about them. `models/users.ts` owns the derive-unless-authored
 * rule -- `resolveNameFields` on the insert side, `updateUser` on the update side -- so the only
 * claims worth making here are that the fields survive the schema, reach the model verbatim, and
 * that the route's own emptiness refusal still fires when neither a name nor a first name would
 * produce a usable display name.
 *
 * `WIKI.models.*` is stubbed rather than DB-backed for the same reason
 * `admin.createWelcomeEmail.test.ts` stubs it: nothing here is SQL orchestration, it is payload
 * plumbing, and the derivation itself already has its own coverage in `models/users.names.test.ts`.
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
        // -> `applyUserUpdate(id, { patch, groups, authFlags })` -- one options object, not a
        //    bare patch; the route wraps the whole write sequence in it (OpenProject #1609).
        applyUserUpdate: async (id: string, args: any) => {
          updateUserCalls.push({ id, patch: args.patch })
          return true
        },
        getUserGroupIds: async () => []
      },
      auditLog: { record: async () => {} },
      groups: {
        hasUnknownGroupIds: async (ids: string[]) => ids.length > 0,
        // -> `systemUserGuard` asks both of these before any update is allowed through.
        holdsSystemPermission: () => false,
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
    // -> Undefined, not the derived string: leaving it out is what lets `resolveNameFields` derive
    //    and leave the account tracking later half edits, rather than being born authored.
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
    // -> The route must NOT decide authorship. `updateUser` reads the stored row to answer that;
    //    a `nameLocallyEdited` set here would pre-empt it (Feature #2608's one-owner rule).
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
