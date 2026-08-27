import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import systemRoutes from './system.ts'
import { importModel } from '../models/siteImport.ts'
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

/**
 * Route-level test for `POST /system/import` (OpenProject #2213).
 *
 * The whole point of the fix is that the request body is never buffered as one `Buffer` in memory —
 * so rather than asserting an absence (hard to observe from outside the process), this exercises the
 * real `WIKI.models.import` (`streamUpload`/`deleteUpload`, unmocked) against a real temp directory
 * and asserts the archive genuinely reaches disk with the right bytes, that a non-gzip/empty upload
 * is refused before ever reaching the handler, and that a file written for a request which turns out
 * to target a missing site is cleaned up rather than left behind. `sites.getSiteById` and
 * `scheduler.addJob` are the only two things mocked — everything about the upload path itself is
 * real.
 */
describe('POST /system/import', () => {
  let app: FastifyInstance
  let dataPath: string
  let getSiteById: ReturnType<typeof mock.fn>
  let addJob: ReturnType<typeof mock.fn>

  const TARGET_SITE_ID = '11111111-1111-1111-1111-111111111111'

  before(async () => {
    dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-import-route-test-'))
    getSiteById = mock.fn(async ({ id }: { id: string }) => (id === TARGET_SITE_ID ? { id } : null))
    addJob = mock.fn(async () => ({ id: 'job-1' }))

    ;(globalThis as any).WIKI = {
      ROOTPATH: '.',
      config: { dataPath },
      models: {
        sites: { getSiteById },
        import: importModel
      },
      scheduler: { addJob }
    }

    app = fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    app.addHook('onRequest', (req, _reply, done) => {
      ;(req as any).session = { authenticated: true, user: { id: 'user-1' }, permissions: [] }
      done()
    })
    await registerErrorSchema(app)
    await registerFlagsSchema(app)
    await registerSecuritySchema(app)
    await registerExtensionSchema(app)
    await app.register(systemRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    await fs.rm(dataPath, { recursive: true, force: true })
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    getSiteById.mock.resetCalls()
    addJob.mock.resetCalls()
  })

  /** Every file this suite writes under `<dataPath>/imports/`, so a leak (or a cleanup) is visible. */
  async function importedFiles(): Promise<string[]> {
    return fs.readdir(path.join(dataPath, 'imports')).catch(() => [])
  }

  test('a real archive reaches disk with its exact bytes, and the job is queued with its path', async () => {
    const archive = zlib.gzipSync(Buffer.from('a fake but valid gzip payload'))

    const res = await app.inject({
      method: 'POST',
      url: `/import?targetSiteId=${TARGET_SITE_ID}`,
      headers: { 'content-type': 'application/gzip' },
      payload: archive
    })

    assert.equal(res.statusCode, 200)
    assert.equal(addJob.mock.callCount(), 1)
    const [{ payload }] = addJob.mock.calls[0].arguments as [{ payload: { filePath: string } }]
    const onDisk = await fs.readFile(payload.filePath)
    assert.deepEqual(onDisk, archive)

    await fs.unlink(payload.filePath).catch(() => {})
  })

  test('an empty body is refused before the handler ever runs, and nothing is left on disk', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/import?targetSiteId=${TARGET_SITE_ID}`,
      headers: { 'content-type': 'application/gzip' },
      payload: Buffer.alloc(0)
    })

    assert.equal(res.statusCode, 400)
    assert.equal(addJob.mock.callCount(), 0)
    assert.deepEqual(await importedFiles(), [])
  })

  test('a non-gzip body is refused, and the partial file it was streamed to is removed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/import?targetSiteId=${TARGET_SITE_ID}`,
      headers: { 'content-type': 'application/gzip' },
      payload: Buffer.from('definitely not a gzip archive')
    })

    assert.equal(res.statusCode, 400)
    assert.equal(addJob.mock.callCount(), 0)
    assert.deepEqual(await importedFiles(), [])
  })

  test('an archive for a target site that does not exist is deleted rather than left behind', async () => {
    const archive = zlib.gzipSync(Buffer.from('irrelevant content'))

    const res = await app.inject({
      method: 'POST',
      url: '/import?targetSiteId=00000000-0000-0000-0000-000000000000',
      headers: { 'content-type': 'application/gzip' },
      payload: archive
    })

    assert.equal(res.statusCode, 404)
    assert.equal(addJob.mock.callCount(), 0)
    assert.deepEqual(
      await importedFiles(),
      [],
      'the archive streamed to disk before the site lookup must be cleaned up, not leaked'
    )
  })
})
