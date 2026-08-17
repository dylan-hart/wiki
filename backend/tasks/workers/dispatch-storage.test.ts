import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { task } from './dispatch-storage.ts'
import type { StorageTarget } from '../../models/storage.ts'

/**
 * Exercises the task's branching (missing target, missing module, missing handler, success, failure)
 * against fake `storage`/`contentSync` models — the point of this test is the task's own control flow,
 * not the models it calls, which have their own tests. See `task()`'s `deps` parameter.
 */
before(() => {
  global.WIKI = {
    ensureDb: async () => true,
    logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  } as unknown as WikiGlobal
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
  await task(
    { payload: basePayload },
    {
      storage: {
        getSiteTargetById: async () => null,
        ensureModule: async () => {
          throw new Error('should not be called')
        }
      } as any,
      contentSync: {
        recordSuccess: async () => recorded.push('success'),
        recordFailure: async () => recorded.push('failure')
      } as any
    }
  )
  assert.deepEqual(recorded, [])
})

test('logs and skips when the module has no implementation', async () => {
  const recorded: string[] = []
  await task(
    { payload: basePayload },
    {
      storage: {
        getSiteTargetById: async () => target,
        ensureModule: async () => null
      } as any,
      contentSync: {
        recordSuccess: async () => recorded.push('success'),
        recordFailure: async () => recorded.push('failure')
      } as any
    }
  )
  assert.deepEqual(recorded, [])
})

test('logs and skips when the module has no matching handler', async () => {
  const recorded: string[] = []
  await task(
    { payload: basePayload },
    {
      storage: {
        getSiteTargetById: async () => target,
        ensureModule: async () => ({ assetUploaded: async () => {} }) // -> no `created`
      } as any,
      contentSync: {
        recordSuccess: async () => recorded.push('success'),
        recordFailure: async () => recorded.push('failure')
      } as any
    }
  )
  assert.deepEqual(recorded, [])
})

test('calls the handler and records success', async () => {
  const calls: any[] = []
  let recordedSuccess: any = null
  await task(
    { payload: basePayload },
    {
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
      } as any
    }
  )
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
      task(
        { payload: basePayload },
        {
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
          } as any
        }
      ),
    /remote unreachable/
  )
  assert.deepEqual(recordedFailure, {
    contentType: 'page',
    contentId: 'p1',
    targetId: 'target-1',
    error: 'remote unreachable'
  })
})
