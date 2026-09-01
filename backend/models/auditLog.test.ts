import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { actorFromRequest, AUDIT_EVENTS, AUDIT_TARGET_TYPES } from './auditLog.ts'
import type { AuditEvent, AuditTargetType } from './auditLog.ts'
import type { FastifyRequest } from 'fastify'

await ensureTemporal()

/**
 * OpenProject #2231/#2237: the system/security/flags/auditLog event vocabulary added to close the
 * gap that made `system.*` and `auditLog.*` writes uncompilable. Listed here once so the DB-backed
 * round trip below and the pure vocabulary check share a single source instead of two copies
 * drifting apart. `auth.strategyUpdated` is deliberately not repeated here -- it predates this
 * vocabulary pass and already has its own round trip in `api/authentication.test.ts`.
 */
const NEW_EVENTS = [
  'system.flagsUpdated',
  'system.securityUpdated',
  'system.extensionInstalled',
  'system.apiStateUpdated',
  'system.metricsUpdated',
  'system.pageviewsUpdated',
  'system.certificatesRegenerated',
  'system.sessionsInvalidated',
  'system.pageHistoryPurged',
  'system.contentExported',
  'system.contentImported',
  'auditLog.retentionChanged',
  'auditLog.purged'
] as const satisfies readonly AuditEvent[]

describe('AUDIT_EVENTS / AUDIT_TARGET_TYPES vocabulary (pure)', () => {
  test('AUDIT_EVENTS includes every new system/security/flags/auditLog event', () => {
    for (const event of NEW_EVENTS) {
      assert.ok(
        (AUDIT_EVENTS as readonly string[]).includes(event),
        `AUDIT_EVENTS is missing ${event}`
      )
    }
  })

  test('AUDIT_TARGET_TYPES includes system', () => {
    assert.ok((AUDIT_TARGET_TYPES as readonly string[]).includes('system'))
  })

  test('AuditEvent rejects a misspelled event name at compile time', () => {
    // @ts-expect-error -- 'system.securityUpdate' (missing the trailing 'd') is not a member of AUDIT_EVENTS
    const invalid: AuditEvent = 'system.securityUpdate'
    assert.ok(invalid)
  })

  test('AuditTargetType rejects a misspelled target type at compile time', () => {
    // @ts-expect-error -- 'systm' is not a member of AUDIT_TARGET_TYPES
    const invalid: AuditTargetType = 'systm'
    assert.ok(invalid)
  })
})

describe('actorFromRequest (pure)', () => {
  test('resolves a session user', () => {
    const req = {
      session: { user: { id: 'user-1', name: 'Jane Doe' } },
      apiKey: null,
      ip: '203.0.113.5'
    } as unknown as FastifyRequest
    assert.deepEqual(actorFromRequest(req), {
      id: 'user-1',
      name: 'Jane Doe',
      ip: '203.0.113.5'
    })
  })

  test('resolves an API key identity, session absent', () => {
    const req = {
      session: {},
      apiKey: { id: 'key-1', permissions: [], groupIds: [] },
      ip: '203.0.113.6'
    } as unknown as FastifyRequest
    assert.deepEqual(actorFromRequest(req), {
      id: null,
      name: 'API Key key-1',
      ip: '203.0.113.6'
    })
  })

  test('a session user takes priority over an API key on the same request', () => {
    const req = {
      session: { user: { id: 'user-1', name: 'Jane Doe' } },
      apiKey: { id: 'key-1', permissions: [], groupIds: [] },
      ip: '203.0.113.7'
    } as unknown as FastifyRequest
    assert.equal(actorFromRequest(req).id, 'user-1')
  })

  test('resolves nobody for an unauthenticated request', () => {
    const req = { session: {}, apiKey: null, ip: '203.0.113.8' } as unknown as FastifyRequest
    assert.deepEqual(actorFromRequest(req), { id: null, name: '', ip: '203.0.113.8' })
  })
})

/**
 * `record`/`list`/`listActors`/`purge` are SQL orchestration -- filtering, joining against `users`
 * for `listActors`, an interval-based delete -- rather than pure logic, so this runs the real methods
 * against a migrated, per-run-fresh database, matching `pageHistory.test.ts`'s own reasoning for the
 * same kind of method.
 */
describe('auditLog record/list/listActors/purge (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let auditLogModel: typeof import('./auditLog.ts').auditLog

  before(async () => {
    fixtures = await setupTestDb()
    ;({ auditLog: auditLogModel } = await import('./auditLog.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('record() writes an entry that list() reads back', async () => {
    await auditLogModel.record({
      event: 'user.created',
      actor: { id: fixtures.userId, name: 'Fixture User', ip: '203.0.113.10' },
      targetType: 'user',
      targetId: fixtures.userId,
      targetLabel: 'fixture@example.com',
      detail: { groups: [fixtures.groupId] }
    })

    const { total, entries } = await auditLogModel.list()
    assert.equal(total, 1)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.event, 'user.created')
    assert.equal(entries[0]!.actor.id, fixtures.userId)
    assert.equal(entries[0]!.actor.name, 'Fixture User')
    assert.equal(entries[0]!.actorIp, '203.0.113.10')
    assert.deepEqual(entries[0]!.detail, { groups: [fixtures.groupId] })
  })

  test('list() filters by event and by actor', async () => {
    await auditLogModel.record({
      event: 'group.created',
      actor: { id: fixtures.userId, name: 'Fixture User' },
      targetType: 'group',
      targetId: fixtures.groupId,
      targetLabel: 'Fixture Group'
    })
    await auditLogModel.record({
      event: 'login.failed',
      actor: { id: null, name: 'someone@example.com' },
      targetType: 'user',
      targetLabel: 'someone@example.com'
    })

    const byEvent = await auditLogModel.list({ event: 'group.created' })
    assert.ok(byEvent.entries.every((e) => e.event === 'group.created'))
    assert.ok(byEvent.entries.length >= 1)

    const byActor = await auditLogModel.list({ actorId: fixtures.userId })
    assert.ok(byActor.entries.every((e) => e.actor.id === fixtures.userId))
    assert.ok(byActor.entries.length >= 1)

    const anonymous = await auditLogModel.list({ event: 'login.failed' })
    assert.equal(anonymous.entries[0]!.actor.id, null)
  })

  test('listActors() lists distinct actors resolved against the live users table', async () => {
    const actors = await auditLogModel.listActors()
    assert.ok(actors.some((a) => a.id === fixtures.userId && a.name === 'Fixture User'))
  })

  test('recordMany() writes N rows field-identical to N successive record() calls', async () => {
    const before = (await auditLogModel.list({ limit: 1000 })).total

    const entries = [
      {
        event: 'group.created' as const,
        actor: { id: fixtures.userId, name: 'Batch Actor One', ip: '203.0.113.20' },
        targetType: 'group' as const,
        targetId: 'batch-target-1',
        targetLabel: 'Batch Target One',
        detail: { batch: 1 },
        siteId: fixtures.siteId
      },
      {
        event: 'apiKey.issued' as const,
        actor: { id: null, name: 'API Key batch-key', ip: '203.0.113.21' },
        targetType: 'apiKey' as const,
        targetId: 'batch-target-2',
        targetLabel: 'Batch Target Two',
        detail: { batch: 2 }
      },
      {
        event: 'site.settingsUpdated' as const,
        actor: { id: fixtures.userId, name: 'Batch Actor Three' },
        targetType: 'site' as const,
        targetId: 'batch-target-3',
        targetLabel: 'Batch Target Three',
        detail: {}
      }
    ]

    await auditLogModel.recordMany(entries)

    const afterBatch = await auditLogModel.list({ limit: 1000 })
    assert.equal(afterBatch.total, before + entries.length)

    for (const entry of entries) {
      const row = afterBatch.entries.find((e) => e.targetId === entry.targetId)
      assert.ok(row, `expected a row for ${entry.targetId}`)
      // Same field values `record()` would have written for this entry -- exercised directly by
      // `record() writes an entry that list() reads back` above, so this checks recordMany() lands
      // the identical shape rather than re-deriving record()'s own behavior.
      assert.equal(row!.event, entry.event)
      assert.equal(row!.actor.id, entry.actor.id)
      assert.equal(row!.actor.name, entry.actor.name)
      assert.equal(row!.actorIp, entry.actor.ip ?? '')
      assert.equal(row!.targetType, entry.targetType)
      assert.equal(row!.targetId, entry.targetId)
      assert.equal(row!.targetLabel, entry.targetLabel)
      assert.deepEqual(row!.detail, entry.detail)
      assert.equal(row!.siteId, entry.siteId ?? null)
      // Timestamps aren't dropped or left null by the batched path -- see the implementation plan's
      // note on why this doesn't assert bit-exact equality against record()'s own timestamps: a
      // single multi-row INSERT shares one transaction-start `now()` across every row in the batch,
      // while N sequential record() calls (each its own implicit transaction) can differ by a few ms.
      assert.ok(row!.createdAt instanceof Date)
      assert.ok(Date.now() - row!.createdAt.getTime() < 5000)
    }

    // The batch's own rows share one INSERT's `now()` -- unlike sequential record() calls, they are
    // not just close to each other, they are identical.
    const batchRows = entries.map((entry) =>
      afterBatch.entries.find((e) => e.targetId === entry.targetId)!
    )
    assert.ok(
      batchRows.every((row) => row.createdAt.getTime() === batchRows[0]!.createdAt.getTime())
    )
  })

  test('recordMany() with an empty array issues no statement', async (t) => {
    const insertSpy = t.mock.method(WIKI.db, 'insert')
    const before = (await auditLogModel.list({ limit: 1000 })).total

    await auditLogModel.recordMany([])

    assert.equal(insertSpy.mock.callCount(), 0)
    assert.equal((await auditLogModel.list({ limit: 1000 })).total, before)
  })

  test('record() accepts each new system/security/flags/auditLog event name', async () => {
    for (const event of NEW_EVENTS) {
      await auditLogModel.record({
        event,
        actor: { id: fixtures.userId, name: 'Fixture User' },
        targetType: 'system',
        targetLabel: event
      })

      const { entries } = await auditLogModel.list({ event })
      assert.ok(
        entries.some((e) => e.event === event),
        `record()/list() round trip failed for ${event}`
      )
    }
  })

  test('purge() drops nothing when every entry is inside the retention window, but still records itself', async () => {
    const before = (await auditLogModel.list()).total
    const purged = await auditLogModel.purge(365)
    assert.equal(purged, 0)
    // OpenProject #2237: purge() always writes its own `auditLog.purged` entry, even a zero-count
    // run, so the log shows the job ran rather than staying silent.
    const after = await auditLogModel.list()
    assert.equal(after.total, before + 1)
    assert.equal(after.entries[0]!.event, 'auditLog.purged')
    assert.equal(after.entries[0]!.detail.count, 0)
    assert.ok(after.entries[0]!.detail.cutoff)
  })

  /*
    OpenProject #1902: the classification-conflicts resolve route writes its audit entries through
    this batched path instead of one `record()` call per page.
  */
  test('recordMany() writes N entries in one call, matching N record() calls', async () => {
    const before = (await auditLogModel.list({ event: 'page.classificationChanged' })).total
    await auditLogModel.recordMany([
      {
        event: 'page.classificationChanged',
        actor: { id: fixtures.userId, name: 'Fixture User' },
        targetType: 'page',
        targetId: 'page-1',
        targetLabel: 'batch/one',
        detail: { from: 'a', to: 'b' }
      },
      {
        event: 'page.classificationChanged',
        actor: { id: fixtures.userId, name: 'Fixture User' },
        targetType: 'page',
        targetId: 'page-2',
        targetLabel: 'batch/two',
        detail: { from: 'a', to: 'b' }
      }
    ])
    const { total, entries } = await auditLogModel.list({ event: 'page.classificationChanged' })
    assert.equal(total, before + 2)
    const targetIds = entries.map((e) => e.targetId).sort()
    assert.deepEqual(targetIds.filter((id) => id === 'page-1' || id === 'page-2').sort(), [
      'page-1',
      'page-2'
    ])
  })

  test('recordMany() with an empty array writes nothing', async () => {
    const before = (await auditLogModel.list()).total
    await auditLogModel.recordMany([])
    assert.equal((await auditLogModel.list()).total, before)
  })

  test('purge() drops entries older than the retention window, then records its own purge', async () => {
    const before = (await auditLogModel.list()).total
    assert.ok(before > 0)
    const purged = await auditLogModel.purge(0)
    assert.equal(purged, before)
    // Only the purge's own new entry survives -- everything that existed before it, including the
    // previous test's `auditLog.purged` row, was older than the (empty) retention window.
    const after = await auditLogModel.list()
    assert.equal(after.total, 1)
    assert.equal(after.entries[0]!.event, 'auditLog.purged')
    assert.equal(after.entries[0]!.detail.count, purged)
    assert.ok(after.entries[0]!.detail.cutoff)
  })
})
