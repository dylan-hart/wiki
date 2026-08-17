import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import systemRoutes from './system.ts'
import { registerSchemas as registerFlagsSchema } from './schemas/flags.ts'
import { registerSchemas as registerSecuritySchema } from './schemas/security.ts'
import { registerSchemas as registerExtensionSchema } from './schemas/extension.ts'

/**
 * Task 605 verification pass: `GET /_api/system/info`'s response schema is what Fastify actually
 * serializes through (fast-json-stringify), so any property the handler returns but the schema does
 * not declare is silently dropped from the wire response, not merely undocumented. Two fields were
 * caught this way:
 *
 * - `dbVersion`: the handler always returned it, and `AdminSystem.vue` always read it (`PostgreSQL
 *   {{ dbVersion }}`), but it was never declared in the `response.200.properties`, so the card has
 *   been silently rendering "PostgreSQL" with nothing after it since the route was written.
 * - `httpPort`: declared in the schema, but the handler had hardcoded `httpPort: 0` — dead weight
 *   that the schema promised meant something. Fixed to read the real `WIKI.config.port`.
 *
 * `WIKI.db.$count` / `.execute` are stubbed rather than pulling in the db/schema/drizzle graph,
 * matching `sites.test.ts`'s pattern for a self-contained unit test of the route's response shape.
 */

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    version: '3.0.0-test',
    config: {
      db: { host: 'db-test-host' },
      api: { isEnabled: true },
      metrics: { isEnabled: false },
      mail: { host: '' },
      update: { version: '3.0.1', versionDate: '2026-01-01T00:00:00.000Z' },
      port: 3042
    },
    dbManager: { VERSION: '17.4', dbName: 'wiki_test' },
    db: {
      $count: async () => 7,
      execute: async () => ({ rows: [] })
    },
    models: {
      jobs: {
        countActive: async () => 2,
        isHealthy: async () => true
      }
    }
  }

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
  await app.register(fastifySensible)
  await registerFlagsSchema(app)
  await registerSecuritySchema(app)
  await registerExtensionSchema(app)
  await app.register(systemRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

test('GET /info includes dbVersion in the actual serialized response', async () => {
  const res = await app.inject({ method: 'GET', url: '/info' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.dbVersion, '17.4')
})

test('GET /info reports the real configured port, not a hardcoded 0', async () => {
  const res = await app.inject({ method: 'GET', url: '/info' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.httpPort, 3042)
})
