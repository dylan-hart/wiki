import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import apiKeysRoutes from './apiKeys.ts'
import { registerSchemas as registerApiKeySchema } from './schemas/apiKey.ts'

/**
 * `POST /_api/api-keys`'s `scope` field is validated against the closed permission vocabulary
 * (`helpers/permissions.ts`) via the `ApiKeyScopePermission` schema, the same way `groups` is
 * validated against a UUID shape. This is a self-contained test of that wiring: `WIKI.models.groups`
 * and `WIKI.models.apiKeys.createKey` are stubbed so the request never touches the database, keeping
 * the assertion on the route's schema and body-handling rather than on model/SQL behavior (covered
 * separately in `models/apiKeys.test.ts`).
 */

const GROUP_ID = '11111111-1111-4111-8111-111111111111'
let createKeyCalls: any[] = []

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      groups: {
        getAllGroups: async () => [{ id: GROUP_ID, name: 'Editors' }]
      },
      apiKeys: {
        createKey: async (args: any) => {
          createKeyCalls.push(args)
          return { id: 'new-key-id', key: 'signed.jwt.token' }
        }
      }
    },
    data: {
      systemIds: {
        guestsGroupId: 'guests-group-id'
      }
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  await registerApiKeySchema(app)
  await app.register(apiKeysRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

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
