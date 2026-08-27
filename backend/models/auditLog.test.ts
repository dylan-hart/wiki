import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { actorFromRequest } from './auditLog.ts'
import type { FastifyRequest } from 'fastify'

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
