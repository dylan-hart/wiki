import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import systemRoutes from './system.ts'
import { importModel } from '../models/siteImport.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import configSvc from '../core/config.ts'

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
    app = await buildTestApp({
      routes: systemRoutes,
      wiki: {
        dbManager: {
          dbName: 'wiki_test'
        },
        db: {
          execute: async () => ({ rows: FAKE_ROWS })
        }
      }
    })
  })

  after(() => closeTestApp(app))

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
    const wiki = {
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

    app = await buildTestApp({ routes: systemRoutes, ajv: true, wiki })
  })

  after(() => closeTestApp(app))

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
 * OpenProject #2335: `GET /pageviews` used to answer just `{ isEnabled }`, leaving
 * `AdminPageviews.vue` no way to show an admin real evidence that tracking is actually recording
 * anything. It now also returns `summary`, sourced straight from `WIKI.models.pageviews.summary()`
 * (that method's own DB-backed tests in `models/pageviews.test.ts` cover the aggregation itself --
 * this route-level test stubs it, same as `GET /info`'s stubbed `WIKI.models.jobs` above, so it's
 * only verifying the route wires the model's return value through unchanged).
 */
describe('GET /pageviews', () => {
  let app: FastifyInstance
  const FAKE_SUMMARY = {
    totalViews: 42,
    last24h: 3,
    last7d: 10,
    distinctPages: 7,
    mostRecentAt: '2026-08-31T00:00:00.000Z'
  }

  before(async () => {
    const wiki = {
      config: { pageviews: { isEnabled: true } },
      models: {
        pageviews: {
          summary: mock.fn(async () => FAKE_SUMMARY)
        }
      }
    }

    app = await buildTestApp({ routes: systemRoutes, ajv: true, wiki })
  })

  after(() => closeTestApp(app))

  test('returns isEnabled from config and summary from WIKI.models.pageviews.summary()', async () => {
    const res = await app.inject({ method: 'GET', url: '/pageviews' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.isEnabled, true)
    assert.deepEqual(body.summary, FAKE_SUMMARY)
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

    const wiki = {
      models: {
        extensions: {
          getExtensions
        }
      }
    }

    app = await buildTestApp({
      routes: systemRoutes,
      ajv: true,
      wiki,
      session: (req: any) =>
        req.headers['x-test-anon'] === 'true'
          ? undefined
          : { authenticated: true, user: { id: 'user-1' }, permissions: [] }
    })
  })

  after(() => closeTestApp(app))

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
 * Task 2213: `POST /import`'s content-type parser used to be `parseAs: 'buffer'`, materialising the
 * whole archive as one in-memory `Buffer` before a single byte reached `<dataPath>/imports/`. It now
 * has no `parseAs` at all, which is what hands the parser the raw request stream instead — this
 * suite runs the real `systemRoutes` plugin with the real `importModel` (against a throwaway
 * `dataPath`) rather than mocking either, so what it actually asserts is that the archive lands on
 * disk at all, with the exact bytes sent, and that `req.body` resolves to that file's path rather
 * than a `Buffer` — the architectural change this task made. Only `WIKI.models.sites.getSiteById` and
 * `WIKI.scheduler.addJob` are mocked, since a real target site and a real job queue are their own
 * suites' concerns.
 */
describe('POST /import (streamed upload)', () => {
  let app: FastifyInstance
  let dataPath: string
  let currentSite: any
  let getSiteById: ReturnType<typeof mock.fn>
  let addJob: ReturnType<typeof mock.fn>

  before(async () => {
    dataPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-import-route-test-'))

    getSiteById = mock.fn(async () => currentSite)
    addJob = mock.fn(async () => ({ id: 'job-1' }))

    app = await buildTestApp({
      routes: systemRoutes,
      ajv: true,
      session: { authenticated: true, user: { id: 'user-1' }, permissions: [] },
      wiki: {
        ROOTPATH: process.cwd(),
        config: { dataPath },
        models: {
          sites: { getSiteById },
          import: importModel,
          auditLog: { record: async () => {} }
        },
        scheduler: { addJob }
      }
    })
  })

  after(async () => {
    await closeTestApp(app)
    await fsp.rm(dataPath, { recursive: true, force: true })
  })

  beforeEach(() => {
    currentSite = { id: 'site-1' }
    getSiteById.mock.resetCalls()
    addJob.mock.resetCalls()
  })

  test('streams the upload straight to disk and queues a job pointing at the saved path, not a Buffer', async () => {
    const gzipHeader = Buffer.from([0x1f, 0x8b, 0x08, 0x00])
    const body = Buffer.concat([gzipHeader, Buffer.from('a fake archive body, not a real tarball')])

    const res = await app.inject({
      method: 'POST',
      url: '/import?targetSiteId=00000000-0000-0000-0000-000000000001',
      headers: { 'content-type': 'application/gzip' },
      payload: body
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      ok: true,
      message: 'Content import queued successfully.',
      id: 'job-1'
    })

    assert.equal(addJob.mock.callCount(), 1)
    const jobPayload = (addJob.mock.calls[0]!.arguments[0] as any).payload
    // -> The content-type parser resolved `req.body` (what `addJob`'s payload carries as `filePath`)
    //    to a string path on disk, never a `Buffer` -- proof the archive was streamed to
    //    `<dataPath>/imports/` rather than held whole in the request thread's memory.
    assert.equal(typeof jobPayload.filePath, 'string')
    assert.match(jobPayload.filePath, /imports[/\\].+\.tar\.gz$/)
    assert.deepEqual(await fsp.readFile(jobPayload.filePath), body)
  })

  test('rejects a body whose first bytes are not gzip, and never queues a job for it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/import?targetSiteId=00000000-0000-0000-0000-000000000001',
      headers: { 'content-type': 'application/gzip' },
      payload: Buffer.from('not a gzip archive at all')
    })

    assert.equal(res.statusCode, 400)
    assert.equal(addJob.mock.callCount(), 0)
  })

  test('deletes the saved upload when the target site does not exist, and never queues a job', async () => {
    currentSite = null
    const before = await fsp.readdir(path.join(dataPath, 'imports')).catch(() => [] as string[])

    const res = await app.inject({
      method: 'POST',
      url: '/import?targetSiteId=00000000-0000-0000-0000-000000000002',
      headers: { 'content-type': 'application/gzip' },
      payload: Buffer.from([0x1f, 0x8b, 0x08, 0x00])
    })

    assert.equal(res.statusCode, 404)
    assert.equal(addJob.mock.callCount(), 0)

    const after = await fsp.readdir(path.join(dataPath, 'imports'))
    assert.equal(
      after.length,
      before.length,
      'expected the upload to have been deleted since the target site does not exist'
    )
  })
})

/**
 * OpenProject #2231: every write route in `system.ts` now records an audit entry. DB-backed rather
 * than a stubbed `WIKI.models.auditLog` -- `PUT /security` and `POST /history/purge` are the two
 * cases the task calls out by name, and what actually has to be verified is what lands in the real
 * `auditLog` table (actor, changed keys, and -- the point of the task -- that no `auth`/`mail`
 * secret value ever reaches `detail`), not just that `record()` was called with some argument.
 * `WIKI.configSvc` is the real `core/config.ts` singleton (not part of `setupTestDb()`'s minimal
 * `WIKI`): `Security#updateConfig` writes through it to the real `settings` table this fixture's
 * migration created.
 */
describe(
  'Write routes record an audit entry (DB-backed, #2231)',
  { skip: !hasTestDatabase() },
  () => {
    let app: FastifyInstance
    let fixtures: TestFixtures
    let auditLogModel: typeof import('../models/auditLog.ts').auditLog

    before(async () => {
      fixtures = await setupTestDb()
      ;({ auditLog: auditLogModel } = await import('../models/auditLog.ts'))
      ;(globalThis as any).WIKI.configSvc = configSvc
      // -> `setupTestDb()`'s minimal `WIKI.config` is a bare `{}` -- `Security#getConfig()` reads
      //    `WIKI.config.security ?? {}`, so without this, `Security#validate()`'s
      //    `CORS_MODES.includes(merged.corsMode)` check fails on `undefined` and `PUT /security`
      //    below 400s instead of exercising the asserted 200 path (OpenProject #2346). `'OFF'` is
      //    the same default `base.yml` ships; the test's own payload never touches CSP/hostname/regex
      //    so nothing else in `security` needs seeding.
      ;(globalThis as any).WIKI.config.security = { corsMode: 'OFF' }

      // -> `buildTestApp` brings the REAL error handler: without one that shapes a thrown
      //    `reply.badRequest()` into `ApiError#`, Fastify's default handler tries to serialize the
      //    raw error against the route's declared error response schema (which requires
      //    `ok`/`error`/`statusCode`/`message`), fails, and falls back to a 500 -- masking whichever
      //    status code the route actually meant to send (OpenProject #2346). No `wiki`:
      //    `setupTestDb()` already installed the real one, which this suite then patches above.
      app = await buildTestApp({
        routes: systemRoutes,
        ajv: true,
        session: {
          authenticated: true,
          user: { id: fixtures.userId, name: 'Fixture User' },
          permissions: ['manage:system'],
          destroy: async () => {}
        }
      })
    })

    after(async () => {
      await closeTestApp(app)
      await teardownTestDb()
    })

    test('PUT /security leaves an audit row naming the actor and the changed keys, with no auth/mail secret in detail', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/security',
        // -> `disallowIframe`/`uploadScanSVG` are real `SECURITY_FIELDS`; `auth`/`mail` are not --
        //    they stand in for a caller trying to slip a secret-bearing blob through this route. The
        //    schema has no `additionalProperties: false`, so these pass validation and reach the
        //    handler; `Security#pickFields` is what has to drop them before `detail` is built.
        //    (Not `trustProxy`, despite it also being a real field: its schema is a genuinely
        //    ambiguous `oneOf: [boolean, string]` that Fastify's default AJV `coerceTypes` fails to
        //    resolve for a bare boolean -- OpenProject #2366 tracks that separately. Using it here
        //    would make this audit-log test fail for an unrelated schema reason.)
        payload: {
          disallowIframe: true,
          uploadScanSVG: false,
          auth: { secret: 'super-secret-session-key' },
          mail: { host: 'smtp.example.com', auth: { user: 'bot', pass: 'hunter2' } }
        }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(res.json().ok, true)

      const { entries } = await auditLogModel.list({ event: 'system.securityUpdated' })
      assert.equal(entries.length, 1)
      const entry = entries[0]!

      assert.equal(entry.actor.id, fixtures.userId)
      assert.equal(entry.actor.name, 'Fixture User')
      assert.deepEqual(Object.keys(entry.detail).sort(), ['disallowIframe', 'uploadScanSVG'])
      assert.equal(entry.detail.disallowIframe, true)
      assert.equal(entry.detail.uploadScanSVG, false)

      const serializedDetail = JSON.stringify(entry.detail)
      assert.doesNotMatch(serializedDetail, /auth|mail|secret|hunter2/i)
    })

    test('POST /history/purge leaves an audit row naming the actor and the changed keys', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/history/purge',
        payload: { olderThan: '24h' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(res.json().ok, true)

      const { entries } = await auditLogModel.list({ event: 'system.pageHistoryPurged' })
      assert.equal(entries.length, 1)
      const entry = entries[0]!

      assert.equal(entry.actor.id, fixtures.userId)
      assert.deepEqual(Object.keys(entry.detail).sort(), ['count', 'olderThan'])
      assert.equal(entry.detail.olderThan, '24h')
      assert.equal(entry.detail.count, res.json().count)
    })
  }
)
