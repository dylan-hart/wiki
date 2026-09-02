import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import systemRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import configSvc from '../../core/config.ts'

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
    let auditLogModel: typeof import('../../models/auditLog.ts').auditLog

    before(async () => {
      fixtures = await setupTestDb()
      ;({ auditLog: auditLogModel } = await import('../../models/auditLog.ts'))
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
