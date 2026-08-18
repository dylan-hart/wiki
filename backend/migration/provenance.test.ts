import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  lookupOrInsert,
  reconcileNaturalKeyMatch,
  resolveExisting,
  SOURCE_SYSTEM_WIKIJS_2_5X
} from './provenance.ts'
import type { MigrationRecord, MigrationRecordKey, ProvenanceStore } from './provenance.ts'

/** A `ProvenanceStore` backed by plain arrays, standing in for a real `WikiDb` the way `phases.test.ts`
 * fakes `SourceConnector` — no live Postgres needed to exercise `lookupOrInsert`'s branching. */
function fakeStore(
  seedRecords: MigrationRecord[] = []
): ProvenanceStore & { records: MigrationRecord[] } {
  const records = [...seedRecords]
  return {
    records,
    async find(key) {
      return records.find(
        (r) =>
          r.siteId === key.siteId &&
          r.sourceSystem === key.sourceSystem &&
          r.sourceTable === key.sourceTable &&
          r.sourceId === key.sourceId
      )
    },
    async record(entry) {
      if (
        records.some(
          (r) =>
            r.siteId === entry.siteId &&
            r.sourceSystem === entry.sourceSystem &&
            r.sourceTable === entry.sourceTable &&
            r.sourceId === entry.sourceId
        )
      ) {
        return
      }
      records.push({ ...entry, importedAt: new Date() })
    },
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
}

function keyOf(sourceId: string): MigrationRecordKey {
  return {
    siteId: 'site-1',
    sourceSystem: SOURCE_SYSTEM_WIKIJS_2_5X,
    sourceTable: 'users',
    sourceId
  }
}

describe('resolveExisting', () => {
  test('returns undefined when nothing matches and there is no natural-key fallback', async () => {
    const result = await resolveExisting(fakeStore(), keyOf('1'))
    assert.equal(result, undefined)
  })

  test('finds an exact provenance-table match without consulting the natural-key fallback', async () => {
    const store = fakeStore([
      { ...keyOf('1'), destTable: 'users', destId: 'dest-1', importedAt: new Date() }
    ])
    let fallbackCalled = false
    const result = await resolveExisting(store, keyOf('1'), async () => {
      fallbackCalled = true
      return 'should-not-be-used'
    })
    assert.deepEqual(result, { destId: 'dest-1', viaNaturalKey: false })
    assert.equal(fallbackCalled, false)
  })

  test('falls back to the natural key when the exact lookup misses', async () => {
    const result = await resolveExisting(fakeStore(), keyOf('1'), async () => 'dest-via-email')
    assert.deepEqual(result, { destId: 'dest-via-email', viaNaturalKey: true })
  })

  test('a natural-key fallback that also misses still returns undefined', async () => {
    const result = await resolveExisting(fakeStore(), keyOf('1'), async () => undefined)
    assert.equal(result, undefined)
  })
})

describe('reconcileNaturalKeyMatch', () => {
  test('backfills a provenance record for a row found only by natural key', async () => {
    const store = fakeStore()
    await reconcileNaturalKeyMatch(store, keyOf('1'), 'users', 'dest-1')
    assert.equal(store.records.length, 1)
    assert.equal(store.records[0].destId, 'dest-1')
    assert.equal(store.records[0].sourceId, '1')
  })
})

describe('lookupOrInsert', () => {
  test('creates and records a brand-new mapping when nothing exists anywhere', async () => {
    const store = fakeStore()
    let created = false
    const result = await lookupOrInsert(store, {
      ...keyOf('1'),
      destTable: 'users',
      create: async () => {
        created = true
        return 'new-dest-id'
      }
    })
    assert.equal(created, true)
    assert.deepEqual(result, {
      destId: 'new-dest-id',
      action: 'created',
      reconciledViaNaturalKey: false
    })
    assert.equal(store.records.length, 1)
    assert.equal(store.records[0].destId, 'new-dest-id')
  })

  test('skips a re-run against an exact provenance match by default, without calling create', async () => {
    const store = fakeStore([
      { ...keyOf('1'), destTable: 'users', destId: 'dest-1', importedAt: new Date() }
    ])
    const result = await lookupOrInsert(store, {
      ...keyOf('1'),
      destTable: 'users',
      create: async () => {
        throw new Error('create() must not be called on a repeat run')
      }
    })
    assert.deepEqual(result, {
      destId: 'dest-1',
      action: 'skipped',
      reconciledViaNaturalKey: false
    })
  })

  test('updates in place instead of skipping when updateExisting is true', async () => {
    const store = fakeStore([
      { ...keyOf('1'), destTable: 'users', destId: 'dest-1', importedAt: new Date() }
    ])
    let updatedWith: string | undefined
    const result = await lookupOrInsert(store, {
      ...keyOf('1'),
      destTable: 'users',
      updateExisting: true,
      update: async (destId) => {
        updatedWith = destId
      },
      create: async () => {
        throw new Error('create() must not be called when an existing mapping was found')
      }
    })
    assert.equal(updatedWith, 'dest-1')
    assert.deepEqual(result, {
      destId: 'dest-1',
      action: 'updated',
      reconciledViaNaturalKey: false
    })
  })

  test('updateExisting with no update callback falls back to skipping rather than throwing', async () => {
    const store = fakeStore([
      { ...keyOf('1'), destTable: 'users', destId: 'dest-1', importedAt: new Date() }
    ])
    const result = await lookupOrInsert(store, {
      ...keyOf('1'),
      destTable: 'users',
      updateExisting: true,
      create: async () => {
        throw new Error('create() must not be called on a repeat run')
      }
    })
    assert.equal(result.action, 'skipped')
  })

  test('the interrupted-run edge case: a natural-key match backfills provenance and is treated as existing', async () => {
    const store = fakeStore()
    const result = await lookupOrInsert(store, {
      ...keyOf('1'),
      destTable: 'users',
      findByNaturalKey: async () => 'dest-created-by-prior-interrupted-run',
      create: async () => {
        throw new Error('create() must not be called once the natural key reconciles the row')
      }
    })
    assert.deepEqual(result, {
      destId: 'dest-created-by-prior-interrupted-run',
      action: 'skipped',
      reconciledViaNaturalKey: true
    })
    // The backfilled record means the *next* run finds it on the exact-key path.
    assert.equal(store.records.length, 1)
    assert.equal(store.records[0].destId, 'dest-created-by-prior-interrupted-run')

    let secondRunCreateCalled = false
    const secondRun = await lookupOrInsert(store, {
      ...keyOf('1'),
      destTable: 'users',
      findByNaturalKey: async () => {
        throw new Error(
          'the exact-key lookup should already have hit, natural key must not run again'
        )
      },
      create: async () => {
        secondRunCreateCalled = true
        return 'should-not-happen'
      }
    })
    assert.equal(secondRunCreateCalled, false)
    assert.deepEqual(secondRun, {
      destId: 'dest-created-by-prior-interrupted-run',
      action: 'skipped',
      reconciledViaNaturalKey: false
    })
  })

  test('a natural-key match honors updateExisting too', async () => {
    const store = fakeStore()
    let updatedWith: string | undefined
    const result = await lookupOrInsert(store, {
      ...keyOf('1'),
      destTable: 'users',
      updateExisting: true,
      findByNaturalKey: async () => 'dest-1',
      update: async (destId) => {
        updatedWith = destId
      },
      create: async () => {
        throw new Error('create() must not be called once the natural key reconciles the row')
      }
    })
    assert.equal(updatedWith, 'dest-1')
    assert.deepEqual(result, { destId: 'dest-1', action: 'updated', reconciledViaNaturalKey: true })
  })

  test('no natural-key fallback given falls straight through to create on a miss', async () => {
    const store = fakeStore()
    const result = await lookupOrInsert(store, {
      ...keyOf('1'),
      destTable: 'users',
      create: async () => 'brand-new'
    })
    assert.equal(result.action, 'created')
  })
})
