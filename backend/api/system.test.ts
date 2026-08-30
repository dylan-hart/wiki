import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import systemRoutes from './system.ts'
import { registerSchemas as registerFlagsSchema } from './schemas/flags.ts'
import { registerSchemas as registerSecuritySchema } from './schemas/security.ts'
import { registerSchemas as registerExtensionSchema } from './schemas/extension.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import { ensureTemporal } from '../test/temporal.ts'

// `getClusterNodes()` (in system.ts) calls `Temporal.Instant.from()` unconditionally on every row;
// `ensureTemporal()` polyfills the global for real on this sandbox's Node, which lacks it natively --
// see `test/temporal.ts` for why this is needed at all.
await ensureTemporal()

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
describe('GET /cluster (renamed from /instances)', () => {
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
})

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
describe('GET /info', () => {
  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
      version: '3.0.0-test',
      config: {
        db: { host: 'db-test-host' },
        api: { isEnabled: true },
        metrics: { isEnabled: false },
        pageviews: { isEnabled: true },
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

  test('GET /info reports isPageviewsEnabled from config, not hardcoded', async () => {
    const res = await app.inject({ method: 'GET', url: '/info' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.isPageviewsEnabled, true)
  })
})

/**
 * Route-level test for `GET /system/extensions/status`.
 *
 * The frontend gates page-import on the Pandoc extension being installed (`PageNewMenu.vue` /
 * `ImportPageDialog.vue`, per task 668), and needs to ask that without `manage:system` — the
 * permission the full `/extensions` listing requires, since that route also carries install
 * eligibility and instructions meant for admins. This route is the "lightweight … check" the task
 * called for: no route-level permissions (open to any caller, like the public site-info route), and
 * answering nothing but `{ <extensionKey>: isInstalled }` for every declared extension.
 */
describe('GET /system/extensions/status', () => {
  let app: FastifyInstance
  let getExtensions: ReturnType<typeof mock.fn>

  before(async () => {
    getExtensions = mock.fn(async () => [
      {
        key: 'pandoc',
        title: 'Pandoc',
        isInstalled: true,
        isInstallable: false,
        isCompatible: true
      },
      {
        key: 'puppeteer',
        title: 'Puppeteer',
        isInstalled: false,
        isInstallable: true,
        isCompatible: true
      }
    ])

    ;(globalThis as any).WIKI = {
      models: {
        extensions: {
          getExtensions
        }
      }
    }

    app = fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    app.addHook('onRequest', (req, _reply, done) => {
      if (req.headers['x-test-anon'] !== 'true') {
        ;(req as any).session = { authenticated: true, user: { id: 'user-1' }, permissions: [] }
      }
      done()
    })
    await registerErrorSchema(app)
    await registerFlagsSchema(app)
    await registerExtensionSchema(app)
    await registerSecuritySchema(app)
    await app.register(systemRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    getExtensions.mock.resetCalls()
  })

  test('answers a key -> isInstalled map for every declared extension', async () => {
    const res = await app.inject({ method: 'GET', url: '/extensions/status' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { pandoc: true, puppeteer: false })
    assert.equal(getExtensions.mock.callCount(), 1)
  })

  test('answers an anonymous caller too — no route-level permission gates it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/extensions/status',
      headers: { 'x-test-anon': 'true' }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { pandoc: true, puppeteer: false })
  })
})
