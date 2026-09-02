import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import apiKeysRoutes from './apiKeys.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * `POST /_api/api-keys`'s `scope` field is validated against the closed permission vocabulary
 * (`helpers/permissions.ts`) via the `ApiKeyScopePermission` schema, the same way `groups` is
 * validated against a UUID shape. This is a self-contained test of that wiring: `WIKI.models.groups`
 * and `WIKI.models.apiKeys.createKey` are stubbed so the request never touches the database, keeping
 * the assertion on the route's schema and body-handling rather than on model/SQL behavior (covered
 * separately in `models/apiKeys.test.ts`).
 */

const GROUP_ID = '11111111-1111-4111-8111-111111111111'
const SITE_ID = '22222222-2222-4222-8222-222222222222'
const LEVEL_ID = '33333333-3333-4333-8333-333333333333'
const EXISTING_KEY_ID = '44444444-4444-4444-8444-444444444444'
let createKeyCalls: any[] = []
let revokeKeyCalls: string[] = []

let app: FastifyInstance

before(async () => {
  const wiki = {
    models: {
      groups: {
        hasUnknownGroupIds: async (ids: string[]) => ids.some((id) => id !== GROUP_ID)
      },
      apiKeys: {
        createKey: async (args: any) => {
          createKeyCalls.push(args)
          return { id: 'new-key-id', key: 'signed.jwt.token' }
        },
        getKeyById: async (id: string) =>
          id === EXISTING_KEY_ID
            ? { id: EXISTING_KEY_ID, name: 'Existing Key', isRevoked: false }
            : null,
        revokeKey: async (id: string) => {
          revokeKeyCalls.push(id)
        }
      },
      classificationLevels: {
        byId: (id: string) => (id === LEVEL_ID ? { id, name: 'Restricted', sortOrder: 2 } : null)
      },
      auditLog: {
        record: mock.fn(async () => {})
      }
    },
    data: {
      systemIds: {
        guestsGroupId: 'guests-group-id'
      }
    },
    sites: {
      [SITE_ID]: { id: SITE_ID, hostname: 'example.com' }
    }
  }

  app = await buildTestApp({
    routes: apiKeysRoutes,
    wiki,
    // -> A request carrying the `x-simulate-api-key` test header is treated as
    //    bearer-token-authenticated (OpenProject #2190) — `manage:system`, so it would pass the real
    //    route-permission gate too, the same as any admin-issued key that the real `onRequest` hook
    //    resolves permissions from.
    session: (req: any) => {
      if (req.headers['x-simulate-api-key']) {
        req.apiKey = { id: 'caller-key-id', permissions: ['manage:system'] }
      }
      return undefined
    }
  })
})

after(() => closeTestApp(app))

test('rejects a scope entry outside the known permission vocabulary', async () => {
  createKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID],
      scope: ['not:a:real:permission']
    }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createKeyCalls.length, 0)
})

test('accepts a scope drawn from the known permission vocabulary and persists it', async () => {
  createKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID],
      scope: ['read:pages']
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createKeyCalls.length, 1)
  assert.deepEqual(createKeyCalls[0].scope, ['read:pages'])
})

test('omitting scope creates an unscoped key (null)', async () => {
  createKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID]
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createKeyCalls.length, 1)
  assert.equal(createKeyCalls[0].scope, null)
})

test('rejects a siteId that names no real site', async () => {
  createKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID],
      siteId: '99999999-9999-4999-8999-999999999999'
    }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createKeyCalls.length, 0)
})

test('rejects an allowedClassifications entry that names no real level (OpenProject #1205)', async () => {
  createKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID],
      allowedClassifications: [LEVEL_ID, '99999999-9999-4999-8999-999999999999']
    }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createKeyCalls.length, 0)
})

test('accepts an allowedClassifications list naming only real levels and persists it (OpenProject #1205)', async () => {
  createKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID],
      allowedClassifications: [LEVEL_ID]
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createKeyCalls.length, 1)
  assert.deepEqual(createKeyCalls[0].allowedClassifications, [LEVEL_ID])
})

test('omitting allowedClassifications creates an unrestricted key (null) (OpenProject #1205)', async () => {
  createKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID]
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createKeyCalls[0].allowedClassifications, null)
})

test('accepts an empty allowedClassifications array (locked out of every classified page), not treated as omitted (OpenProject #1205)', async () => {
  createKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID],
      allowedClassifications: []
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createKeyCalls.length, 1)
  assert.deepEqual(createKeyCalls[0].allowedClassifications, [])
})

test('accepts a siteId naming a real site and persists it', async () => {
  createKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID],
      siteId: SITE_ID
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createKeyCalls.length, 1)
  assert.equal(createKeyCalls[0].siteId, SITE_ID)
})

test('omitting siteId creates an instance-wide key (null)', async () => {
  createKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID]
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createKeyCalls.length, 1)
  assert.equal(createKeyCalls[0].siteId, null)
})

/**
 * OpenProject #989: issuing/revoking an admin-issued API key is one of the events the audit log is
 * meant to capture. The tests above stub `auditLog.record` only to keep the route from throwing —
 * this checks it is actually called, with the id `createKey` returned rather than the key itself.
 */
test('creating a key records an apiKey.issued audit log entry, never the key value', async () => {
  createKeyCalls = []
  ;(globalThis as any).WIKI.models.auditLog.record.mock.resetCalls()
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID]
    }
  })
  assert.equal(res.statusCode, 200)
  const calls = (globalThis as any).WIKI.models.auditLog.record.mock.calls
  assert.equal(calls.length, 1)
  const call = calls[0].arguments[0]
  assert.equal(call.event, 'apiKey.issued')
  assert.equal(call.targetType, 'apiKey')
  assert.equal(call.targetId, 'new-key-id')
  assert.equal(call.targetLabel, 'Test Key')
  assert.equal(JSON.stringify(call).includes('signed.jwt.token'), false)
})

/**
 * OpenProject #2190: a bearer-token (API key) caller cannot mint or revoke a key, including itself --
 * even with `manage:system`, which is enough to pass the route-permission gate `index.ts`'s
 * `preHandler` applies from `req.apiKey.permissions`. Session-authenticated requests (no `req.apiKey`
 * set, the shape every other test in this file already uses) are unaffected.
 */
test('POST / refuses a request carrying a verified req.apiKey, even with manage:system', async () => {
  createKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    headers: { 'x-simulate-api-key': '1' },
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID]
    }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(createKeyCalls.length, 0)
})

test('POST / still succeeds for an equivalent session-authenticated (no req.apiKey) request', async () => {
  createKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Test Key',
      expiration: '30d',
      groups: [GROUP_ID]
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createKeyCalls.length, 1)
})

test('POST /:keyId/revoke refuses a request carrying a verified req.apiKey, even with manage:system', async () => {
  revokeKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: `/${EXISTING_KEY_ID}/revoke`,
    headers: { 'x-simulate-api-key': '1' }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(revokeKeyCalls.length, 0)
})

test('POST /:keyId/revoke still succeeds for an equivalent session-authenticated (no req.apiKey) request', async () => {
  revokeKeyCalls = []
  const res = await app.inject({
    method: 'POST',
    url: `/${EXISTING_KEY_ID}/revoke`
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(revokeKeyCalls, [EXISTING_KEY_ID])
})
