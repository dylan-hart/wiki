import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { runReplicationPostImport } from './replicationPostImport.ts'
import type { ReplicationPostImportDeps } from './replicationPostImport.ts'

/**
 * Pure unit coverage for the shared post-import side effect both callers of
 * `models/replicationImport.ts#importSnapshot()` run once a restore has actually succeeded --
 * `tasks/simple/replication-import.ts` (manual upload) and `models/replication.ts#pull()`
 * (scheduled cron-driven pull). No `WIKI` global, no database.
 */

const restoredSites = [{ id: 'site-1' }, { id: 'site-2' }]

function makeDeps(overrides: Partial<ReplicationPostImportDeps> = {}) {
  const calls = {
    sitesBroadcastReload: 0,
    groupsBroadcastReload: 0,
    classificationLevelsBroadcastReload: 0,
    forgetAllPaths: 0,
    invalidateCache: [] as string[],
    addJob: [] as any[]
  }
  const deps: ReplicationPostImportDeps = {
    sites: {
      broadcastReload: mock.fn(async () => {
        calls.sitesBroadcastReload++
      }),
      getAllSites: mock.fn(async () => restoredSites as any)
    } as any,
    groups: {
      broadcastReload: mock.fn(async () => {
        calls.groupsBroadcastReload++
      })
    } as any,
    classificationLevels: {
      broadcastReload: mock.fn(async () => {
        calls.classificationLevelsBroadcastReload++
      })
    } as any,
    glossary: {
      invalidateCache: mock.fn((siteId: string) => {
        calls.invalidateCache.push(siteId)
      })
    } as any,
    assetServing: {
      forgetAllPaths: mock.fn(() => {
        calls.forgetAllPaths++
      })
    } as any,
    addJob: mock.fn(async (opts: any) => {
      calls.addJob.push(opts)
      return { id: `job-for-${opts.payload.siteId}` }
    }),
    ...overrides
  }
  return { deps, calls }
}

describe('runReplicationPostImport', () => {
  test('broadcast-reloads every ClusterReloaded cache, in order', async () => {
    const { deps, calls } = makeDeps()
    const order: string[] = []
    ;(deps.sites.broadcastReload as any).mock.mockImplementation(async () => {
      order.push('sites')
      calls.sitesBroadcastReload++
    })
    ;(deps.groups.broadcastReload as any).mock.mockImplementation(async () => {
      order.push('groups')
      calls.groupsBroadcastReload++
    })
    ;(deps.classificationLevels.broadcastReload as any).mock.mockImplementation(async () => {
      order.push('classificationLevels')
      calls.classificationLevelsBroadcastReload++
    })

    await runReplicationPostImport(deps)

    assert.deepEqual(order, ['sites', 'groups', 'classificationLevels'])
    assert.equal(calls.sitesBroadcastReload, 1)
    assert.equal(calls.groupsBroadcastReload, 1)
    assert.equal(calls.classificationLevelsBroadcastReload, 1)
  })

  test('drops the asset path-resolution cache wholesale', async () => {
    const { deps, calls } = makeDeps()
    await runReplicationPostImport(deps)
    assert.equal(calls.forgetAllPaths, 1)
  })

  test('invalidates the glossary and queues a search rebuild for every restored site', async () => {
    const { deps, calls } = makeDeps()
    await runReplicationPostImport(deps)
    assert.deepEqual(calls.invalidateCache, ['site-1', 'site-2'])
    assert.deepEqual(calls.addJob, [
      { task: 'rebuildSearchIndex', payload: { siteId: 'site-1' } },
      { task: 'rebuildSearchIndex', payload: { siteId: 'site-2' } }
    ])
  })

  test('queues nothing when no site was restored', async () => {
    const { deps, calls } = makeDeps({
      sites: {
        broadcastReload: mock.fn(async () => {
          calls.sitesBroadcastReload++
        }),
        getAllSites: mock.fn(async () => [])
      } as any
    })
    await runReplicationPostImport(deps)
    assert.deepEqual(calls.invalidateCache, [])
    assert.deepEqual(calls.addJob, [])
  })

  test('propagates a side effect failure rather than swallowing it', async () => {
    const { deps } = makeDeps({
      groups: {
        broadcastReload: mock.fn(async () => {
          throw new Error('cache reload failed')
        })
      } as any
    })
    await assert.rejects(runReplicationPostImport(deps), /cache reload failed/)
  })
})
