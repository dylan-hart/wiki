import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { definePhase } from './define-phase.ts'
import type { MigrationContext } from '../context.ts'
import type { ProvenanceStore } from '../provenance.ts'
import type { WriteRecorder } from '../recorder.ts'

/** A `ProvenanceStore` that never matches anything — no test here exercises idempotency, only the
 * write-capability reclassification `definePhase` itself owns. */
const stubProvenanceStore: ProvenanceStore = {
  async find() {
    return undefined
  },
  async record() {},
  async findExistingUserByEmail() {
    return undefined
  },
  async findExistingPageByPath() {
    return undefined
  },
  async findExistingAssetByFolderAndFilename() {
    return undefined
  }
}

function contextWith(overrides: Partial<MigrationContext> = {}): MigrationContext {
  return {
    db: {} as any,
    source: {} as any,
    siteId: 'test-site',
    dryRun: false,
    provenanceStore: stubProvenanceStore,
    updateExisting: false,
    ...overrides
  }
}

/** Yields `count` bare records. */
async function* recordsOf(count: number): AsyncGenerator<unknown> {
  for (let i = 0; i < count; i++) {
    yield { id: i }
  }
}

describe('definePhase: write-capability reclassification', () => {
  test('a phase whose entity has a working source and classify, but never supplies write, reports not_implemented even though records were read', async () => {
    const phase = definePhase({
      id: 'content',
      label: 'no write path yet',
      dependsOn: [],
      entities: () => ({
        widgets: {
          source: () => recordsOf(3),
          classify: async (_record, recorder: WriteRecorder) => {
            await recorder.create('some-id')
          }
        }
      })
    })

    const result = await phase.run(contextWith())

    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.notImplemented, ['widgets'])
    assert.deepEqual(result.counts, { widgets: 3 })
    assert.equal(result.report?.found, 3)
    assert.equal(result.report?.wouldCreate, 3)
  })

  test('a phase whose entity has a working source but no classify at all (default classify) also reports not_implemented', async () => {
    const phase = definePhase({
      id: 'settings',
      label: 'default classify, no write',
      dependsOn: [],
      entities: () => ({
        settings: { source: () => recordsOf(2) }
      })
    })

    const result = await phase.run(contextWith())

    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.notImplemented, ['settings'])
  })

  test('a phase whose entity yields zero records is still not_implemented, not ok, when it has no write path', async () => {
    const phase = definePhase({
      id: 'users',
      label: 'zero rows, no write path',
      dependsOn: [],
      entities: () => ({
        users: { source: () => recordsOf(0) }
      })
    })

    const result = await phase.run(contextWith())

    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.notImplemented, ['users'])
    assert.deepEqual(result.counts, { users: 0 })
  })

  test('a phase whose entity DOES supply a write callback still reports ok (existing behavior preserved)', async () => {
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
    assert.equal(result.notImplemented, undefined)
    assert.deepEqual(result.counts, { assets: 2 })
    assert.equal(writeCalls, 2)
  })

  test('write-capability is detected even in dry-run mode, where write() itself is never invoked', async () => {
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

  test('a phase with multiple entities, none supplying write, gets every entity reclassified into notImplemented', async () => {
    const phase = definePhase({
      id: 'content',
      label: 'multiple entities, no write path',
      dependsOn: [],
      entities: () => ({
        pages: { source: () => recordsOf(2) },
        tags: { source: () => recordsOf(1) }
      })
    })

    const result = await phase.run(contextWith())

    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.notImplemented, ['pages', 'tags'])
    assert.deepEqual(result.counts, { pages: 2, tags: 1 })
  })
})
