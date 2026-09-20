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

/** Pass-through: these tests exercise the task's control flow, not real Postgres locking. */
const noopLock = async (_key: string, fn: () => Promise<any>) => fn()

before(() => {
  installTestWiki({ ensureDb: async () => true })
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

// The real `withAdvisoryLock` and the real `contentSync`, not the fakes above: the point is genuine
// connection-pool contention, which a fake would only re-describe. The pool is capped at `max: 2`
// with one connection held by an unrelated caller for the whole run, so `recordSuccess` can only get
// a connection if the lock has already released its own.

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
    // The real `contentSync.recordSuccess` below calls `Temporal.Now.instant()`.
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
      const smallPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 2,
        options: `-c search_path=${fixtures.schema},public`
      })
      const smallDb = drizzle({ client: smallPool, relations }) as WikiDb

      // -> Stands in for a concurrent dispatch holding a connection: leaves exactly one slot free.
      const holderClient = await smallPool.connect()

      const originalDb = CARDINAL.db
      CARDINAL.db = smallDb
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
              // -> No db query of its own: stands for the module's real network I/O, leaving
              //    `recordSuccess` as the only thing competing for a connection.
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

        // -> Confirms `recordSuccess` actually ran, not just that the race did not time out.
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
        CARDINAL.db = originalDb
        holderClient.release()
        await smallPool.end()
      }
    }
  )
})
