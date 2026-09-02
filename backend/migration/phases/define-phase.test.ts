import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { NotYetImplementedError } from '../connector.ts'
import { definePhase } from './define-phase.ts'
import type { MigrationContext } from '../context.ts'
import type { WriteRecorder } from '../recorder.ts'

function contextWith(overrides: Partial<MigrationContext> = {}): MigrationContext {
  return {
    db: {} as any,
    source: {} as any,
    siteId: 'test-site',
    dryRun: false,
    localStrategyId: 'test-local-strategy-uuid',
    systemGroupIds: { admin: 'test-admin-group-uuid', guest: 'test-guest-group-uuid' },
    operatorActorId: 'test-operator-uuid',
    ...overrides
  }
}

/** A source whose iteration rejects on the first `next()` — how a connector method that fails from
 * inside the stream, rather than when called, reaches `readEntity()`. */
function failsDuringIteration(error: Error): () => AsyncIterable<unknown> {
  return () => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) })
  })
}

/** Yields `count` bare records. */
async function* recordsOf(count: number): AsyncGenerator<unknown> {
  for (let i = 0; i < count; i++) {
    yield { id: i }
  }
}

describe('definePhase', () => {
  test('counts every record an entity reads and reports ok', async () => {
    const phase = definePhase({
      id: 'content',
      label: 'two entities',
      dependsOn: [],
      entities: () => ({
        pages: { source: () => recordsOf(3) },
        tags: { source: () => recordsOf(1) }
      })
    })

    const result = await phase.run(contextWith())

    assert.equal(result.status, 'ok')
    assert.equal(result.notImplemented, undefined)
    assert.deepEqual(result.counts, { pages: 3, tags: 1 })
    assert.equal(result.report?.found, 4)
    assert.equal(result.report?.wouldCreate, 4)
  })

  test('a phase whose entity supplies a write callback runs it once per record', async () => {
    let writeCalls = 0
    const phase = definePhase({
      id: 'assets',
      label: 'has a real write path',
      dependsOn: [],
      entities: () => ({
        assets: {
          source: () => recordsOf(2),
          classify: async (_record, recorder: WriteRecorder) => {
            await recorder.create('some-id', async () => {
              writeCalls++
            })
          }
        }
      })
    })

    const result = await phase.run(contextWith({ dryRun: false }))

    assert.equal(result.status, 'ok')
    assert.equal(writeCalls, 2)
  })

  test('a dry run still classifies every record but never invokes the write', async () => {
    let writeCalls = 0
    const phase = definePhase({
      id: 'assets',
      label: 'has a real write path, dry run',
      dependsOn: [],
      entities: () => ({
        assets: {
          source: () => recordsOf(2),
          classify: async (_record, recorder: WriteRecorder) => {
            await recorder.create('some-id', async () => {
              writeCalls++
            })
          }
        }
      })
    })

    const result = await phase.run(contextWith({ dryRun: true }))

    assert.equal(result.status, 'ok')
    assert.equal(writeCalls, 0)
    assert.equal(result.report?.wouldCreate, 2)
  })

  test('an entity whose generator is still a NotYetImplementedError stub reports not_implemented without aborting the phase', async () => {
    const phase = definePhase({
      id: 'users',
      label: 'one real entity, one stub',
      dependsOn: [],
      entities: () => ({
        groups: { source: () => recordsOf(2) },
        users: {
          source: () => {
            throw new NotYetImplementedError('users', 'a test stub')
          }
        }
      })
    })

    const result = await phase.run(contextWith())

    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.notImplemented, ['users'])
    assert.deepEqual(result.counts, { groups: 2 })
    assert.equal(result.report?.found, 2)
  })

  test('a stub that throws from inside the iteration is treated the same way', async () => {
    const phase = definePhase({
      id: 'settings',
      label: 'throws mid-iteration',
      dependsOn: [],
      entities: () => ({
        settings: {
          source: failsDuringIteration(new NotYetImplementedError('settings', 'a test stub'))
        }
      })
    })

    const result = await phase.run(contextWith())

    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.notImplemented, ['settings'])
  })

  test('any other error aborts the phase with an emptied report', async () => {
    const phase = definePhase({
      id: 'content',
      label: 'a real fault',
      dependsOn: [],
      entities: () => ({
        pages: { source: failsDuringIteration(new Error('connection reset')) }
      })
    })

    const result = await phase.run(contextWith())

    assert.equal(result.status, 'error')
    assert.deepEqual(result.errors, ['connection reset'])
    assert.deepEqual(result.report, {
      phase: 'content',
      found: 0,
      wouldCreate: 0,
      wouldSkipExisting: 0,
      conflicts: [],
      unmappable: []
    })
  })
})
