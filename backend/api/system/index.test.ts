import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import systemRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import configSvc from '../../core/config.ts'

/**
 * DB-backed rather than a stubbed `CARDINAL.models.auditLog`: what has to hold is what lands in the
 * real `auditLog` table -- above all that no `auth`/`mail` secret reaches `detail`. The real
 * `configSvc` is installed by hand: `setupTestDb()`'s minimal `CARDINAL` has none, and
 * `Security#updateConfig` saves through it.
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
      ;(globalThis as any).CARDINAL.configSvc = configSvc
      // -> `setupTestDb()`'s `CARDINAL.config` is a bare `{}`, and `Security#validate()` refuses an
      //    undefined `corsMode`, so `PUT /security` would 400. `'OFF'` is `base.yml`'s default.
      ;(globalThis as any).CARDINAL.config.security = { corsMode: 'OFF' }

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
        // -> `auth`/`mail` are not `SECURITY_FIELDS`: they stand in for a secret-bearing blob. The
        //    schema has no `additionalProperties: false`, so they reach the handler, and
        //    `Security#pickFields` is what has to drop them before `detail` is built.
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

    test('PUT /security accepts a real boolean trustProxy (OpenProject #2366)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/security',
        payload: { trustProxy: true }
      })
      assert.equal(res.statusCode, 200, res.body)
      assert.equal(res.json().ok, true)

      // -> Found by key rather than by position: the test above wrote an entry for the same event,
      //    and the two timestamps can tie.
      const { entries } = await auditLogModel.list({ event: 'system.securityUpdated' })
      const entry = entries.find((e) => 'trustProxy' in e.detail)
      assert.ok(entry, 'expected an audit entry recording the trustProxy change')
      assert.equal(entry.detail.trustProxy, true)
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
