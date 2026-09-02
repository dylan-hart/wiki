import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import apiKeysRoutes from './apiKeys.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Task 622: the `siteId` and `scope` fields added to API keys (tasks 612/616) must actually surface
 * in the generated OpenAPI document, not just validate at runtime -- `hideUntagged` (CLAUDE.md,
 * "Routes") means a schema gap here is invisible in the Swagger UI at `/_api`, not just undocumented.
 * This registers the real `@fastify/swagger` plugin (no stub standing in for it) against the real
 * route/schema modules and inspects the document it actually produces.
 *
 * `@fastify/swagger`'s default `refResolver` renames every `$id`-registered schema to a positional
 * `def-N` component key, carrying the original `$id` forward only as that component's `.title` --
 * so schemas are looked up by title below, the same way a human skimming the raw JSON at `/_api/json`
 * would have to.
 */

let app: FastifyInstance

function schemaByTitle(doc: any, title: string) {
  const entry = Object.entries(doc.components.schemas).find(([, s]: any) => s.title === title)
  if (!entry) {
    return undefined
  }
  const [defKey, schema] = entry
  return { defKey, ...(schema as object) }
}

before(async () => {
  app = await buildTestApp({
    routes: apiKeysRoutes,
    swagger: true,
    wiki: {
      models: {
        groups: { hasUnknownGroupIds: async (ids: string[]) => ids.length > 0 },
        apiKeys: { createKey: async () => ({}) }
      },
      data: { systemIds: { guestsGroupId: 'guests-group-id' } }
    }
  })
})

after(() => closeTestApp(app))

test('the ApiKey schema documents siteId and scope', () => {
  const doc: any = app.swagger()
  const apiKeySchema: any = schemaByTitle(doc, 'ApiKey')

  assert.ok(apiKeySchema, 'ApiKey schema is registered')
  assert.deepEqual([...apiKeySchema.properties.siteId.type].sort(), ['null', 'string'])
  assert.deepEqual([...apiKeySchema.properties.scope.type].sort(), ['array', 'null'])

  const scopeItemsRef = apiKeySchema.properties.scope.items.$ref
  const scopePermissionSchema: any = schemaByTitle(doc, 'ApiKeyScopePermission')
  assert.equal(scopeItemsRef, `#/components/schemas/${scopePermissionSchema.defKey}`)
})

test('POST /_api/api-keys documents siteId and scope in its request body', () => {
  const doc: any = app.swagger()
  const createOp = doc.paths['/'].post
  const bodyProps = createOp.requestBody.content['application/json'].schema.properties

  assert.ok(bodyProps.siteId, 'siteId is documented on the create-key body')
  assert.deepEqual([...bodyProps.siteId.type].sort(), ['null', 'string'])
  assert.ok(bodyProps.scope, 'scope is documented on the create-key body')
  assert.deepEqual([...bodyProps.scope.type].sort(), ['array', 'null'])
})

test('the ApiKeyScopePermission enum matches the closed permission vocabulary', () => {
  const doc: any = app.swagger()
  const enumSchema: any = schemaByTitle(doc, 'ApiKeyScopePermission')

  assert.ok(Array.isArray(enumSchema.enum) && enumSchema.enum.length > 0)
  assert.ok(enumSchema.enum.includes('manage:system'))
  assert.ok(enumSchema.enum.includes('read:pages'))
})

test('GET /_api/api-keys response references the ApiKey schema (list stays visible under hideUntagged)', () => {
  const doc: any = app.swagger()
  const listOp = doc.paths['/'].get
  const itemsRef = listOp.responses['200'].content['application/json'].schema.items.$ref
  const apiKeySchema: any = schemaByTitle(doc, 'ApiKey')

  assert.equal(itemsRef, `#/components/schemas/${apiKeySchema.defKey}`)
})
