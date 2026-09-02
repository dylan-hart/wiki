import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './users.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * `POST /` (create user)'s `sendWelcomeEmail` handling (OpenProject #961): the route used to refuse
 * the flag unconditionally, with a comment claiming no mail transport existed — `models/mail.ts` has
 * been a full SMTP transport since well before this fix, used by registration and password reset.
 * `WIKI.models.users`/`auditLog`/`mail` are stubbed so the request never touches the database or a
 * real SMTP connection; `WIKI.data.systemIds.localAuthId` is exercised for real since the route reads
 * it directly.
 */

const LOCAL_AUTH_ID = '00000000-0000-4000-8000-000000000001'
const NEW_USER_ID = '11111111-1111-4111-8111-111111111111'

let app: FastifyInstance
let mailConfigured: boolean
let sendWelcomeEmailImpl: (args: any) => Promise<void>
let generateTokenCalls: any[]
let sendWelcomeEmailCalls: any[]
let auditLogCalls: any[]

before(async () => {
  const wiki = {
    data: { systemIds: { localAuthId: LOCAL_AUTH_ID } },
    models: {
      users: {
        getByEmail: async () => null,
        createUser: async () => NEW_USER_ID
      },
      // -> Token minting moved off `users` when `models/userCredentials.ts` was split out; the route
      //    reads it here now.
      userCredentials: {
        generateToken: async (args: any) => {
          generateTokenCalls.push(args)
          return 'welcome-token-123'
        }
      },
      auditLog: {
        record: async (args: any) => {
          auditLogCalls.push(args)
        }
      },
      groups: {
        hasUnknownGroupIds: async (ids: string[]) => ids.length > 0
      },
      mail: {
        isConfigured: () => mailConfigured,
        sendWelcomeEmail: async (args: any) => {
          sendWelcomeEmailCalls.push(args)
          return sendWelcomeEmailImpl(args)
        }
      }
    }
  }

  app = await buildTestApp({ routes: usersRoutes, wiki })
})

after(() => closeTestApp(app))

beforeEach(() => {
  mailConfigured = true
  generateTokenCalls = []
  sendWelcomeEmailCalls = []
  auditLogCalls = []
  sendWelcomeEmailImpl = async () => {}
})

function createPayload(overrides: Record<string, any> = {}) {
  return {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    password: 'a-long-password',
    ...overrides
  }
}

test('refuses sendWelcomeEmail before creating the user when no mail transport is configured', async () => {
  mailConfigured = false
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: createPayload({ sendWelcomeEmail: true })
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'userCreateWelcomeEmailUnavailable')
  assert.equal(generateTokenCalls.length, 0)
  assert.equal(sendWelcomeEmailCalls.length, 0)
  assert.equal(auditLogCalls.length, 0, 'the user must never be created on this refusal')
})

test('creating a user with sendWelcomeEmail unset never touches mail at all', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: createPayload()
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().id, NEW_USER_ID)
  assert.equal(generateTokenCalls.length, 0)
  assert.equal(sendWelcomeEmailCalls.length, 0)
})

test('sendWelcomeEmail generates a resetPwd token scoped to the local strategy and emails it', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: createPayload({
      sendWelcomeEmail: true,
      sendWelcomeEmailFromSiteId: '22222222-2222-4222-8222-222222222222'
    })
  })

  assert.equal(res.statusCode, 200)
  assert.equal(generateTokenCalls.length, 1)
  assert.equal(generateTokenCalls[0].kind, 'resetPwd')
  assert.equal(generateTokenCalls[0].userId, NEW_USER_ID)
  assert.equal(generateTokenCalls[0].meta.strategyId, LOCAL_AUTH_ID)

  assert.equal(sendWelcomeEmailCalls.length, 1)
  assert.equal(sendWelcomeEmailCalls[0].to, 'ada@example.com')
  assert.equal(sendWelcomeEmailCalls[0].name, 'Ada Lovelace')
  assert.equal(sendWelcomeEmailCalls[0].token, 'welcome-token-123')
  assert.equal(sendWelcomeEmailCalls[0].siteId, '22222222-2222-4222-8222-222222222222')
})

test('a failed welcome-email send is logged but still reports the user as created', async () => {
  sendWelcomeEmailImpl = async () => {
    throw new Error('ECONNREFUSED')
  }

  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: createPayload({ sendWelcomeEmail: true })
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(res.json().id, NEW_USER_ID)
})
