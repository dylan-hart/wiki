import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import auditLogRoutes from './auditLog.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { AUDIT_LOG_RETENTION_DAYS_FLOOR } from '../models/auditLog.ts'

await ensureTemporal()

describe('audit-log route gating', () => {
  let app: FastifyInstance
  const recorded: any[] = []
  const entry = (n: number) => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    event: 'login.success',
    actor: { id: null, name: 'A' },
    actorIp: '',
    targetType: '',
    targetId: '',
    targetLabel: '',
    detail: {},
    siteId: null,
    createdAt: new Date('2026-01-01T00:00:00Z')
  })
  let retentionSaved = false

  before(async () => {
    app = await buildTestApp({
      routes: auditLogRoutes,
      session: 'header',
      permissions: true,
      wiki: {
        models: {
          auditLog: {
            record: async (e: any) => {
              recorded.push(e)
            },
            list: async () => ({ total: 0, entries: [] }),
            listActors: async () => [],
            getRetentionDays: () => 365,
            setRetentionDays: async () => {
              retentionSaved = true
              return true
            },
            exportBatches: async function* () {
              yield [entry(1), entry(2)]
              yield [entry(3)]
            }
          }
        }
      }
    })
  })

  after(async () => {
    await closeTestApp(app)
  })

  const as = (...permissions: string[]) => ({ 'x-test-permissions': JSON.stringify(permissions) })

  test('read:audit can list and read the actor filter', async () => {
    for (const url of ['/', '/actors']) {
      const res = await app.inject({ method: 'GET', url, headers: as('read:audit') })
      assert.equal(res.statusCode, 200, url)
    }
  })

  test('read:audit can export, and the stream is one JSON entry per line', async () => {
    recorded.length = 0
    const res = await app.inject({ method: 'GET', url: '/export', headers: as('read:audit') })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /^application\/x-ndjson/)
    assert.match(String(res.headers['content-disposition']), /^attachment; filename=".+\.ndjson"$/)
    const lines = res.body.split('\n')
    assert.equal(lines.pop(), '', 'output ends with a newline')
    assert.equal(lines.length, 3)
    assert.deepEqual(
      lines.map((l) => JSON.parse(l).id),
      [1, 2, 3].map((n) => entry(n).id)
    )
  })

  test('an export records auditLog.exported with its filters', async () => {
    recorded.length = 0
    const actorId = '11111111-1111-4111-8111-111111111111'
    const res = await app.inject({
      method: 'GET',
      url: `/export?actorId=${actorId}&event=login.failed`,
      headers: as('read:audit')
    })
    assert.equal(res.statusCode, 200)
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].event, 'auditLog.exported')
    assert.deepEqual(recorded[0].detail.filters, { actorId, event: 'login.failed' })
  })

  test('read:audit cannot read or change the retention setting', async () => {
    retentionSaved = false
    const get = await app.inject({ method: 'GET', url: '/settings', headers: as('read:audit') })
    assert.equal(get.statusCode, 403)
    const put = await app.inject({
      method: 'PUT',
      url: '/settings',
      headers: as('read:audit'),
      payload: { retentionDays: 60 }
    })
    assert.equal(put.statusCode, 403)
    assert.equal(retentionSaved, false)
  })

  test('manage:system still reaches everything', async () => {
    for (const url of ['/', '/actors', '/export', '/settings']) {
      const res = await app.inject({ method: 'GET', url, headers: as('manage:system') })
      assert.equal(res.statusCode, 200, url)
    }
  })

  test('a caller without read:audit is refused list and export, and an anonymous one is a 401', async () => {
    for (const url of ['/', '/actors', '/export']) {
      const res = await app.inject({ method: 'GET', url, headers: as('read:pages') })
      assert.equal(res.statusCode, 403, url)
      const anon = await app.inject({ method: 'GET', url })
      assert.equal(anon.statusCode, 401, url)
    }
  })
})

describe('audit-log settings API (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let app: FastifyInstance
  let fixtures: TestFixtures
  let auditLogModel: typeof import('../models/auditLog.ts').auditLog

  before(async () => {
    fixtures = await setupTestDb()
    ;({ auditLog: auditLogModel } = await import('../models/auditLog.ts'))

    // `setRetentionDays()` persists through `CARDINAL.configSvc.saveToDb()`, which `setupTestDb()`
    // does not install.
    ;(globalThis as any).CARDINAL.configSvc = {
      saveToDb: async () => true
    }

    // -> No `wiki`: `setupTestDb()` already installed the global.
    app = await buildTestApp({ routes: auditLogRoutes, session: 'header', permissions: true })
  })

  after(async () => {
    await closeTestApp(app)
    await teardownTestDb()
  })

  const asAdmin = { 'x-test-permissions': JSON.stringify(['manage:system']) }
  // -> Holds something, just not what the route asks for: that is the 403 case. No session at all
  //    is a 401.
  const asUnprivileged = { 'x-test-permissions': JSON.stringify(['read:pages']) }

  test('PUT /settings records auditLog.retentionChanged before the new retention takes effect', async () => {
    const from = auditLogModel.getRetentionDays()
    let entryExistedDuringSave = false
    const originalSaveToDb = (globalThis as any).CARDINAL.configSvc.saveToDb
    ;(globalThis as any).CARDINAL.configSvc.saveToDb = async (...args: unknown[]) => {
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
      ;(globalThis as any).CARDINAL.configSvc.saveToDb = originalSaveToDb
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
    // Still the 45 the previous test applied.
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

  test('GET /export streams every matching entry across batches, newest first, and audits itself first', async () => {
    const actor = { id: fixtures.userId, name: 'Fixture User' }
    for (let i = 0; i < 5; i++) {
      await auditLogModel.record({ event: 'login.failed', actor, targetLabel: `export-${i}` })
    }
    const expected = (await auditLogModel.list({ event: 'login.failed', limit: 500 })).entries

    const streamed: any[] = []
    for await (const batch of auditLogModel.exportBatches({ event: 'login.failed' }, 2)) {
      assert.ok(batch.length <= 2)
      streamed.push(...batch)
    }
    assert.deepEqual(
      streamed.map((e) => e.id),
      expected.map((e) => e.id)
    )

    const before = (await auditLogModel.list({ event: 'auditLog.exported' })).total
    const res = await app.inject({
      method: 'GET',
      url: '/export?event=auditLog.exported',
      headers: { 'x-test-permissions': JSON.stringify(['read:audit']) }
    })
    assert.equal(res.statusCode, 200)
    const lines = res.body.split('\n').filter(Boolean)
    assert.equal(lines.length, before + 1, 'the export includes the record of itself')
    assert.equal(JSON.parse(lines[0]!).event, 'auditLog.exported')
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
