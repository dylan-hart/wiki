import { test, before, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { task } from './dispatch-storage.ts'
import type { StorageTarget } from '../../models/storage.ts'
import { and, eq } from 'drizzle-orm'
import { relations } from '../../db/relations.ts'
import {
  contentSyncState as contentSyncStateTable,
  storage as storageTable
} from '../../db/schema.ts'
import { contentSync } from '../../models/contentSync.ts'
import { withAdvisoryLock } from '../../helpers/advisoryLock.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import type { WikiDb } from '../../core/db.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { installTestWiki } from '../../test/mocks.ts'

/** A pass-through lock: these tests exercise the task's own control flow, not real Postgres locking. */
const noopLock = async (_key: string, fn: () => Promise<any>) => fn()

/**
 * Exercises the task's branching (missing target, missing module, missing handler, success, failure)
 * against fake `storage`/`contentSync` models — the point of this test is the task's own control flow,
 * not the models it calls, which have their own tests. See `task()`'s `deps` parameter.
 */
before(() => {
  installTestWiki({
    ensureDb: async () => true,
    logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  })
})

const target = { id: 'target-1', module: 'git', title: 'Git' } as unknown as StorageTarget

const basePayload = {
  targetId: 'target-1',
  siteId: 'site-1',
  contentType: 'page' as const,
  contentId: 'p1',
  handler: 'created',
  data: { id: 'p1', siteId: 'site-1' }
}

test('logs and skips when the target no longer exists', async () => {
  const recorded: string[] = []
  await task(basePayload, undefined, {
    storage: {
      getSiteTargetById: async () => null,
      ensureModule: async () => {
        throw new Error('should not be called')
      }
    } as any,
    contentSync: {
      recordSuccess: async () => recorded.push('success'),
      recordFailure: async () => recorded.push('failure')
    } as any,
    withLock: noopLock
  })
  assert.deepEqual(recorded, [])
})

test('logs and skips when the module has no implementation', async () => {
  const recorded: string[] = []
  await task(basePayload, undefined, {
    storage: {
      getSiteTargetById: async () => target,
      ensureModule: async () => null
    } as any,
    contentSync: {
      recordSuccess: async () => recorded.push('success'),
      recordFailure: async () => recorded.push('failure')
    } as any,
    withLock: noopLock
  })
  assert.deepEqual(recorded, [])
})

test('logs and skips when the module has no matching handler', async () => {
  const recorded: string[] = []
  await task(basePayload, undefined, {
    storage: {
      getSiteTargetById: async () => target,
      ensureModule: async () => ({ assetUploaded: async () => {} }) // -> no `created`
    } as any,
    contentSync: {
      recordSuccess: async () => recorded.push('success'),
      recordFailure: async () => recorded.push('failure')
    } as any,
    withLock: noopLock
  })
  assert.deepEqual(recorded, [])
})

test('calls the handler and records success', async () => {
  const calls: any[] = []
  let recordedSuccess: any = null
  await task(basePayload, undefined, {
    storage: {
      getSiteTargetById: async () => target,
      ensureModule: async () => ({
        created: async (t: StorageTarget, data: Record<string, any>) => {
          calls.push([t, data])
        }
      })
    } as any,
    contentSync: {
      recordSuccess: async (args: any) => {
        recordedSuccess = args
      },
      recordFailure: async () => {
        throw new Error('should not be called')
      }
    } as any,
    withLock: noopLock
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], target)
  assert.deepEqual(calls[0][1], basePayload.data)
  assert.deepEqual(recordedSuccess, {
    contentType: 'page',
    contentId: 'p1',
    targetId: 'target-1',
    direction: 'push'
  })
})

test('records failure and rethrows when the handler throws', async () => {
  let recordedFailure: any = null
  await assert.rejects(
    () =>
      task(basePayload, undefined, {
        storage: {
          getSiteTargetById: async () => target,
          ensureModule: async () => ({
            created: async () => {
              throw new Error('remote unreachable')
            }
          })
        } as any,
        contentSync: {
          recordSuccess: async () => {
            throw new Error('should not be called')
          },
          recordFailure: async (args: any) => {
            recordedFailure = args
          }
        } as any,
        withLock: noopLock
      }),
    /remote unreachable/
  )
  assert.deepEqual(recordedFailure, {
    contentType: 'page',
    contentId: 'p1',
    targetId: 'target-1',
    error: 'remote unreachable'
  })
})

// ---------------------------------------------------------------------------------------------
// Target-level payload (`storageSyncTick` / a queued `/actions/:action`) -- no `contentType`/
// `contentId`, so there is no per-content state to record.
// ---------------------------------------------------------------------------------------------

const tickPayload = {
  targetId: 'target-1',
  siteId: 'site-1',
  handler: 'sync',
  data: {}
}

test('calls a whole-target handler and records nothing in contentSync on success', async () => {
  const calls: any[] = []
  await task(tickPayload, undefined, {
    storage: {
      getSiteTargetById: async () => target,
      ensureModule: async () => ({
        sync: async (t: StorageTarget, data: Record<string, any>) => {
          calls.push([t, data])
        }
      })
    } as any,
    contentSync: {
      recordSuccess: async () => {
        throw new Error('should not be called for a target-level payload')
      },
      recordFailure: async () => {
        throw new Error('should not be called for a target-level payload')
      }
    } as any,
    withLock: noopLock
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], target)
  assert.deepEqual(calls[0][1], {})
})

test('rethrows a whole-target handler failure without touching contentSync', async () => {
  await assert.rejects(
    () =>
      task(tickPayload, undefined, {
        storage: {
          getSiteTargetById: async () => target,
          ensureModule: async () => ({
            sync: async () => {
              throw new Error('remote unreachable')
            }
          })
        } as any,
        contentSync: {
          recordSuccess: async () => {
            throw new Error('should not be called for a target-level payload')
          },
          recordFailure: async () => {
            throw new Error('should not be called for a target-level payload')
          }
        } as any,
        withLock: noopLock
      }),
    /remote unreachable/
  )
})

// ---------------------------------------------------------------------------------------------
// Locking (OpenProject #823 item 7) -- the handler call is serialized per `targetId` through
// `withLock`, so two dispatches racing the same on-disk repo (a write-path push and a scheduled
// sync, say) cannot run their git commands concurrently. See `helpers/advisoryLock.ts`.
// ---------------------------------------------------------------------------------------------

test('runs the handler inside withLock, keyed by targetId', async () => {
  const lockCalls: string[] = []
  await task(basePayload, undefined, {
    storage: {
      getSiteTargetById: async () => target,
      ensureModule: async () => ({ created: async () => {} })
    } as any,
    contentSync: { recordSuccess: async () => {}, recordFailure: async () => {} } as any,
    withLock: async (key: string, fn: () => Promise<any>) => {
      lockCalls.push(key)
      return fn()
    }
  })
  assert.deepEqual(lockCalls, ['storage-target:target-1'])
})

test('a handler failure still releases the lock — withLock is not left permanently held', async () => {
  let released = false
  await assert.rejects(
    () =>
      task(basePayload, undefined, {
        storage: {
          getSiteTargetById: async () => target,
          ensureModule: async () => ({
            created: async () => {
              throw new Error('boom')
            }
          })
        } as any,
        contentSync: {
          recordSuccess: async () => {},
          recordFailure: async () => {}
        } as any,
        withLock: async (_key: string, fn: () => Promise<any>) => {
          try {
            return await fn()
          } finally {
            released = true
          }
        }
      }),
    /boom/
  )
  assert.equal(released, true)
})

// ---------------------------------------------------------------------------------------------
// Pool-exhaustion regression (OpenProject #2252) -- `contentSync.recordSuccess`/`recordFailure`
// must run *after* `withAdvisoryLock`'s callback returns, not from inside it. `withAdvisoryLock`
// checks a connection out of the pool for the whole callback's duration; a `recordSuccess` call
// still inside it needs a *second* connection while the callback is still holding the first. On a
// pool already at its configured `max` -- several concurrent dispatches, each holding its own lock
// connection -- that second `pool.connect()` has nothing to wait on but a connection none of those
// calls can ever free, since none of them can return without it first: a deadlock, not a stall.
//
// Exercised against the real `withAdvisoryLock` and the real `contentSync` model (not the
// dependency-injected fakes above -- the whole point here is genuine connection-pool contention,
// which a fake would only re-describe) over a Postgres pool deliberately capped at `max: 2`, with
// one of those two connections held by an unrelated caller for the run's whole duration -- exactly
// "the pool is at its configured max" from the outside. The fixed ordering frees the lock's own
// connection the moment the handler (the callback) returns, which is what leaves a slot for
// `recordSuccess`'s own `WIKI.db` write; the old ordering would starve on it forever.
//
// Skipped unless DATABASE_URL points at a real, migratable Postgres instance -- see `test/db.ts`.
// ---------------------------------------------------------------------------------------------

describe('deadlock regression: recordSuccess after the lock, not inside it', () => {
  const skip = hasTestDatabase()
    ? false
    : 'requires DATABASE_URL (a Postgres instance, migrations applied by setupTestDb)'

  let fixtures: TestFixtures
  let targetId: string

  before(async () => {
    if (!hasTestDatabase()) {
      return
    }
    // `contentSync.recordSuccess` (exercised for real below, not the dependency-injected fake) calls
    // `Temporal.Now.instant()` unconditionally -- this sandbox's Node lacks the native global. See
    // `test/temporal.ts`'s header.
    await ensureTemporal()
    fixtures = await setupTestDb()
    const [row] = await fixtures.db
      .insert(storageTable)
      .values({ siteId: fixtures.siteId, module: 'test-module' })
      .returning({ id: storageTable.id })
    targetId = row!.id
  })

  after(async () => {
    if (!hasTestDatabase()) {
      return
    }
    await teardownTestDb()
  })

  test(
    'a dispatchStorage run completes rather than deadlocking when the pool is at its configured max',
    { skip },
    async () => {
      // -> A pool of its own, capped at 2, pointed at the same schema `setupTestDb()` migrated --
      //    small enough that a single externally-held connection is "the pool at max" in practice.
      const smallPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 2,
        options: `-c search_path=${fixtures.schema},public`
      })
      const smallDb = drizzle({ client: smallPool, relations }) as WikiDb

      // -> Simulates a concurrent dispatch already holding a connection (its own lock, or its own
      //    in-flight network I/O) -- leaves exactly one slot free in the pool.
      const holderClient = await smallPool.connect()

      const originalDb = WIKI.db
      WIKI.db = smallDb
      try {
        const payload = {
          targetId,
          siteId: fixtures.siteId,
          contentType: 'page' as const,
          contentId: randomUUID(),
          handler: 'created',
          data: {}
        }

        const result = await Promise.race([
          task(payload, undefined, {
            storage: {
              getSiteTargetById: async () => ({ id: targetId, module: 'test-module' }) as any,
              // -> No `WIKI.db` query of its own -- represents the module's real (non-db) network
              //    I/O, e.g. a git push or an S3 PUT. Only `recordSuccess`, below, touches the db.
              ensureModule: async () => ({ created: async () => {} })
            } as any,
            contentSync,
            withLock: withAdvisoryLock
          }).then(() => 'completed'),
          delay(3000).then(() => 'timed-out')
        ])

        assert.equal(
          result,
          'completed',
          'dispatchStorage deadlocked instead of completing — recordSuccess is still running inside ' +
            "withLock's callback"
        )

        // -> Confirms recordSuccess actually ran (not just that the race didn't time out).
        const [state] = await originalDb
          .select()
          .from(contentSyncStateTable)
          .where(
            and(
              eq(contentSyncStateTable.targetId, targetId),
              eq(contentSyncStateTable.contentId, payload.contentId)
            )
          )
        assert.ok(state, 'expected a contentSyncState row from recordSuccess')
        assert.equal(state!.lastError, null)
      } finally {
        WIKI.db = originalDb
        holderClient.release()
        await smallPool.end()
      }
    }
  )
})
