import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import systemRoutes from './system.ts'
import { registerSchemas as registerFlagsSchema } from './schemas/flags.ts'
import { registerSchemas as registerSecuritySchema } from './schemas/security.ts'
import { registerSchemas as registerExtensionSchema } from './schemas/extension.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

// `getClusterNodes()` (in system.ts) calls `Temporal.Instant.from()` unconditionally on every row.
// Node ships `Temporal` as a global from v26 -- but not every environment running this test has
// that landed yet, and `@js-temporal/polyfill` (already pulled in transitively by drizzle-kit) is
// a faithful ponyfill, so install it as the global only when it is genuinely missing. On a runtime
// that already has native `Temporal` this import is inert.
if (typeof Temporal === 'undefined') {
  const { Temporal: TemporalPolyfill } = await import('@js-temporal/polyfill')
  ;(globalThis as any).Temporal = TemporalPolyfill
}

/**
 * Regression test for task 711 (Feature 411): the admin area used to expose this cluster-node
 * listing as `GET /_api/system/instances`, with an `instancesTotal` count on `/_api/system/info` --
 * a name that reads as a synonym of the unrelated `AdminSites.vue` / `/_admin/sites` multi-tenancy
 * concept out of context. Both were renamed to `cluster` / `clusterTotal`; this pins the new route
 * and field names, plus the row-grouping logic in `getClusterNodes()` (unchanged, just renamed from
 * `getInstances()`), against a fake `pg_stat_activity` result set rather than a real Postgres --
 * `WIKI.db.execute` is stubbed to return two connections for one instance and one for another, which
 * is exactly the shape `getClusterNodes()` groups by `application_name`.
 */

const FAKE_ROWS = [
  {
    usename: 'wiki',
    client_addr: '10.0.0.1',
    application_name: 'Wiki.js - aaaaaaaaaa:MAIN',
    backend_start: '2026-08-17 09:00:00.000000+00',
    state_change: '2026-08-17 09:05:00.000000+00'
  },
  {
    usename: 'wiki',
    client_addr: '10.0.0.1',
    application_name: 'Wiki.js - aaaaaaaaaa:PUBSUB',
    backend_start: '2026-08-17 09:00:00.000000+00',
    state_change: '2026-08-17 09:05:30.000000+00'
  },
  {
    usename: 'wiki',
    client_addr: '10.0.0.2',
    application_name: 'Wiki.js - bbbbbbbbbb:MAIN',
    backend_start: '2026-08-17 09:01:00.000000+00',
    state_change: '2026-08-17 09:06:00.000000+00'
  }
]

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    dbManager: {
      dbName: 'wiki_test'
    },
    db: {
      execute: async () => ({ rows: FAKE_ROWS })
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  await registerErrorSchema(app)
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

test('GET /cluster lists cluster nodes grouped by instance id (not /instances)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/cluster'
  })
  assert.equal(res.statusCode, 200)
  const nodes = res.json()
  assert.equal(nodes.length, 2)
  const nodeA = nodes.find((n: any) => n.id === 'aaaaaaaaaa')
  assert.ok(nodeA, 'expected the two aaaaaaaaaa connections to be grouped into one node')
  assert.equal(nodeA.activeConnections, 1)
  assert.equal(nodeA.activeListeners, 1)
})

test('GET /instances no longer exists', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/instances'
  })
  assert.equal(res.statusCode, 404)
})
