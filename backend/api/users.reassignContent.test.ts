import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './users.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * `POST /:userId/reassignContent` is the route this task exists to add: `models/users.test.ts`
 * covers `reassignContent()`'s own SQL orchestration and validation against a real database, so what
 * is left to verify here is the route's own wiring — user lookup, the `systemUserGuard` reuse it
 * shares with every other mutation on a `userId`, and turning a thrown `ERR_*` into a 400 the way
 * `rethrowAsBadRequest` does everywhere else in this file. `WIKI.models.users` and `WIKI.models.groups`
 * are stubbed so the request never touches the database.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_ID = '22222222-2222-4222-8222-222222222222'

let app: FastifyInstance
let reassignCalls: any[]
let getByIdImpl: (id: string) => Promise<any>
let holdsSystemPermission: boolean
let userHoldsSystemPermission: boolean
let reassignImpl: (fromUserId: string, toUserId: string) => Promise<any>

before(async () => {
  const wiki = {
    models: {
      users: {
        getById: async (id: string) => getByIdImpl(id),
        reassignContent: async (fromUserId: string, toUserId: string) => {
          reassignCalls.push({ fromUserId, toUserId })
          return reassignImpl(fromUserId, toUserId)
        }
      },
      groups: {
        holdsSystemPermission: () => holdsSystemPermission,
        userHoldsSystemPermission: async () => userHoldsSystemPermission
      }
    }
  }

  app = await buildTestApp({ routes: usersRoutes, wiki })
})

after(() => closeTestApp(app))

beforeEach(() => {
  reassignCalls = []
  holdsSystemPermission = true
  userHoldsSystemPermission = false
  getByIdImpl = async (id: string) => (id === USER_ID ? { id: USER_ID, isSystem: false } : null)
  reassignImpl = async () => ({ pagesReassigned: 3, assetsReassigned: 1 })
})

test('reassigns content and reports the counts the model returns', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/${USER_ID}/reassignContent`,
    payload: { targetUserId: TARGET_ID }
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    ok: true,
    message: 'Content reassigned successfully.',
    pagesReassigned: 3,
    assetsReassigned: 1
  })
  assert.deepEqual(reassignCalls, [{ fromUserId: USER_ID, toUserId: TARGET_ID }])
})

test('404s when the departing user does not exist, without calling reassignContent', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/00000000-0000-0000-0000-000000000000/reassignContent`,
    payload: { targetUserId: TARGET_ID }
  })

  assert.equal(res.statusCode, 404)
  assert.equal(reassignCalls.length, 0)
})

test('refuses to touch a manage:system-protected user for a caller who does not hold it', async () => {
  holdsSystemPermission = false
  userHoldsSystemPermission = true

  const res = await app.inject({
    method: 'POST',
    url: `/${USER_ID}/reassignContent`,
    payload: { targetUserId: TARGET_ID }
  })

  assert.equal(res.statusCode, 403)
  assert.equal(reassignCalls.length, 0)
})

test('turns ERR_REASSIGN_SAME_USER into a 400', async () => {
  reassignImpl = async () => {
    throw new Error('ERR_REASSIGN_SAME_USER')
  }

  const res = await app.inject({
    method: 'POST',
    url: `/${USER_ID}/reassignContent`,
    payload: { targetUserId: USER_ID }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_REASSIGN_SAME_USER')
})

test('turns ERR_INVALID_USER into a 400', async () => {
  reassignImpl = async () => {
    throw new Error('ERR_INVALID_USER')
  }

  const res = await app.inject({
    method: 'POST',
    url: `/${USER_ID}/reassignContent`,
    payload: { targetUserId: '99999999-9999-4999-8999-999999999999' }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_INVALID_USER')
})

test('turns ERR_REASSIGN_TARGET_IS_SYSTEM into a 400', async () => {
  reassignImpl = async () => {
    throw new Error('ERR_REASSIGN_TARGET_IS_SYSTEM')
  }

  const res = await app.inject({
    method: 'POST',
    url: `/${USER_ID}/reassignContent`,
    payload: { targetUserId: TARGET_ID }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_REASSIGN_TARGET_IS_SYSTEM')
})

test('an unexpected model failure is not swallowed into a 400', async () => {
  reassignImpl = async () => {
    throw new Error('a real bug, not an ERR_ code')
  }

  const res = await app.inject({
    method: 'POST',
    url: `/${USER_ID}/reassignContent`,
    payload: { targetUserId: TARGET_ID }
  })

  assert.equal(res.statusCode, 500)
})

test('rejects a body missing targetUserId', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/${USER_ID}/reassignContent`,
    payload: {}
  })

  assert.equal(res.statusCode, 400)
  assert.equal(reassignCalls.length, 0)
})
