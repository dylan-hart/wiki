import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import auditLogRoutes from './auditLog.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { AUDIT_LOG_RETENTION_DAYS_FLOOR } from '../models/auditLog.ts'

await ensureTemporal()

/**
 * DB-backed route test for OpenProject #2237: `PUT /_api/audit-log/settings` against a real,
 * migrated database and the real `WIKI.models.auditLog` -- what this proves is the route's own
 * behavior (recording `auditLog.retentionChanged` before the new value takes effect, and rejecting
 * a value below the floor), not `record()`/`purge()`'s own SQL orchestration, which is
 * `models/auditLog.test.ts`'s job. Mirrors `api/classificationLevels.test.ts`'s DB-backed pattern,
 * including its fake permission `preHandler` standing in for the real session/cookie hook in
 * `index.ts`.
 */
describe('audit-log settings API (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let app: FastifyInstance
  let fixtures: TestFixtures
  let auditLogModel: typeof import('../models/auditLog.ts').auditLog

  before(async () => {
    fixtures = await setupTestDb()
    ;({ auditLog: auditLogModel } = await import('../models/auditLog.ts'))

    // `setRetentionDays()` persists through `WIKI.configSvc.saveToDb()`, which `test/db.ts`'s shared
    // fixture does not install (no DB-backed suite has needed it before this one) -- a minimal stub
    // is enough here since this route's own contract is about ordering and the in-memory value, not
    // config persistence itself.
    ;(globalThis as any).WIKI.configSvc = {
      saveToDb: async () => true
    }

    // -> The REAL permission hook, over a session seeded from a test header rather than a cookie.
    //    No `wiki`: `setupTestDb()` already installed the real one.
    app = await buildTestApp({ routes: auditLogRoutes, session: 'header', permissions: true })
  })

  after(async () => {
    await closeTestApp(app)
    await teardownTestDb()
  })

  const asAdmin = { 'x-test-permissions': JSON.stringify(['manage:system']) }
  // -> An authenticated caller holding SOMETHING, just not what the route asks for: that is the 403
  //    case. A request carrying no session at all is a 401, which the real hook answers and this
  //    test is not about.
  const asUnprivileged = { 'x-test-permissions': JSON.stringify(['read:pages']) }

  test('PUT /settings records auditLog.retentionChanged before the new retention takes effect', async () => {
    const from = auditLogModel.getRetentionDays()
    let entryExistedDuringSave = false
    const originalSaveToDb = (globalThis as any).WIKI.configSvc.saveToDb
    ;(globalThis as any).WIKI.configSvc.saveToDb = async (...args: unknown[]) => {
      // By the time the setting is actually persisted, the record of the change must already be in
      // the log -- this is the "before the new retention takes effect" ordering the route promises.
      const { total } = await auditLogModel.list({ event: 'auditLog.retentionChanged' })
      entryExistedDuringSave = total > 0
      return originalSaveToDb(...args)
    }
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/settings',
        headers: asAdmin,
        payload: { retentionDays: 45 }
      })
      assert.equal(res.statusCode, 200)
    } finally {
      ;(globalThis as any).WIKI.configSvc.saveToDb = originalSaveToDb
    }

    assert.ok(entryExistedDuringSave)
    assert.equal(auditLogModel.getRetentionDays(), 45)

    const { entries } = await auditLogModel.list({ event: 'auditLog.retentionChanged' })
    const written = entries.find((e) => e.detail.to === 45)
    assert.ok(written, 'expected an auditLog.retentionChanged entry for the new value')
    assert.equal(written!.detail.from, from)
  })

  test('PUT /settings rejects a value below the floor and records nothing', async () => {
    const before = (await auditLogModel.list({ event: 'auditLog.retentionChanged' })).total

    const res = await app.inject({
      method: 'PUT',
      url: '/settings',
      headers: asAdmin,
      payload: { retentionDays: AUDIT_LOG_RETENTION_DAYS_FLOOR - 1 }
    })
    assert.equal(res.statusCode, 400)

    const after = (await auditLogModel.list({ event: 'auditLog.retentionChanged' })).total
    assert.equal(after, before)
    // The floor is a real value, not a formality -- confirm the previously-applied setting held.
    assert.equal(auditLogModel.getRetentionDays(), 45)
  })

  test('PUT /settings is refused without manage:system', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/settings',
      headers: asUnprivileged,
      payload: { retentionDays: 60 }
    })
    assert.equal(res.statusCode, 403)
  })

  test('purge() leaves its own auditLog.purged row with count and cutoff', async () => {
    await auditLogModel.record({
      event: 'login.success',
      actor: { id: fixtures.userId, name: 'Fixture User' },
      targetType: 'user',
      targetLabel: 'fixture@example.com'
    })
    const before = (await auditLogModel.list()).total

    const purged = await auditLogModel.purge(0)
    assert.equal(purged, before)

    const { entries } = await auditLogModel.list({ event: 'auditLog.purged' })
    assert.ok(entries.length > 0)
    const latest = entries[0]!
    assert.equal(latest.detail.count, purged)
    assert.ok(latest.detail.cutoff)
  })
})
