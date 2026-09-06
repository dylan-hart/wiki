import { describe, test, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { task } from './replication-import.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * Exercises the task's control flow — including the post-import cache/index side effects, mirroring
 * `import-content.test.ts`'s own coverage of the single-site version this generalizes — against fake
 * `replicationImport`/`sites`/`groups`/`classificationLevels`/`glossary`/`assetServing`/`jobs` models
 * and a fake `addJob`, not a real database. See `task()`'s `deps` parameter.
 */

let wikiHandle: { restore(): void }

after(() => {
  wikiHandle.restore()
})

beforeEach(() => {
  wikiHandle = installTestWiki({
    logger: { info: mock.fn(), error: mock.fn(), warn: mock.fn(), debug: mock.fn() }
  })
})

const payload = { filePath: '/tmp/replication-upload.tar.gz' }
const importResult = {
  sites: 1,
  classificationLevels: 3,
  groups: 2,
  users: 5,
  userGroups: 5,
  navigation: 1,
  tree: 10,
  pages: 8,
  pageHistory: 12,
  assets: 4,
  comments: 6,
  settings: 20
}
const restoredSites = [{ id: 'site-1' }, { id: 'site-2' }]

function makeDeps(overrides: Partial<Parameters<typeof task>[2]> = {}) {
  const calls = {
    importSnapshot: [] as any[],
    sitesBroadcastReload: 0,
    groupsBroadcastReload: 0,
    classificationLevelsBroadcastReload: 0,
    forgetAllPaths: 0,
    invalidateCache: [] as any[],
    addJob: [] as any[],
    setResult: [] as any[],
    deleteUpload: [] as any[]
  }
  const deps = {
    replicationImport: {
      importSnapshot: mock.fn(async (...args: any[]) => {
        calls.importSnapshot.push(args)
        return importResult
      }),
      deleteUpload: mock.fn(async (filePath: string) => {
        calls.deleteUpload.push(filePath)
      })
    } as any,
    sites: {
      broadcastReload: mock.fn(async () => {
        calls.sitesBroadcastReload++
      }),
      getAllSites: mock.fn(async () => restoredSites)
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
    jobs: {
      setResult: mock.fn(async (id: string, result: any) => {
        calls.setResult.push([id, result])
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

describe('replication-import.task', () => {
  test('reloads every replicated cache and queues one search rebuild per restored site', async () => {
    const { deps, calls } = makeDeps()

    // -> OpenProject #2672: the outcome is returned for the scheduler to log, separately from the
    //    `setResult` write a follow-up route reads.
    const outcome = await task(payload, 'job-1', deps)
    assert.deepEqual(outcome, { summary: 'restored replication snapshot' })

    assert.equal(calls.importSnapshot.length, 1)
    assert.deepEqual(calls.importSnapshot[0], [payload.filePath])

    // -> Every ClusterReloaded cache a snapshot just replaced wholesale is broadcast-reloaded, not
    //    just reloaded locally.
    assert.equal(calls.sitesBroadcastReload, 1)
    assert.equal(calls.groupsBroadcastReload, 1)
    assert.equal(calls.classificationLevelsBroadcastReload, 1)

    // -> Asset path cache dropped wholesale.
    assert.equal(calls.forgetAllPaths, 1)

    // -> Glossary invalidated and a search rebuild queued for every restored site, not just one.
    assert.deepEqual(calls.invalidateCache, ['site-1', 'site-2'])
    assert.deepEqual(calls.addJob, [
      { task: 'rebuildSearchIndex', payload: { siteId: 'site-1' } },
      { task: 'rebuildSearchIndex', payload: { siteId: 'site-2' } }
    ])

    // -> Job result is still recorded, after the side effects.
    assert.deepEqual(calls.setResult, [['job-1', importResult]])

    // -> Upload is cleaned up on success too.
    assert.deepEqual(calls.deleteUpload, [payload.filePath])
  })

  test('does not reload caches, invalidate the glossary, forget asset paths, or queue a rebuild when the import itself fails', async () => {
    const { deps, calls } = makeDeps({
      replicationImport: {
        importSnapshot: mock.fn(async () => {
          throw new Error('malformed replication archive')
        }),
        deleteUpload: mock.fn(async (filePath: string) => {
          calls.deleteUpload.push(filePath)
        })
      } as any
    })

    await assert.rejects(() => task(payload, 'job-1', deps), /malformed replication archive/)

    assert.equal(calls.sitesBroadcastReload, 0)
    assert.equal(calls.groupsBroadcastReload, 0)
    assert.equal(calls.classificationLevelsBroadcastReload, 0)
    assert.equal(calls.forgetAllPaths, 0)
    assert.deepEqual(calls.invalidateCache, [])
    assert.deepEqual(calls.addJob, [])
    assert.deepEqual(calls.setResult, [])

    // -> The uploaded working file is still cleaned up on failure, unlike the cache/index side effects.
    assert.deepEqual(calls.deleteUpload, [payload.filePath])
  })

  test('still deletes the upload when a post-import side effect throws', async () => {
    const { deps, calls } = makeDeps({
      sites: {
        broadcastReload: mock.fn(async () => {
          throw new Error('cache reload failed')
        }),
        getAllSites: mock.fn(async () => restoredSites)
      } as any
    })

    await assert.rejects(() => task(payload, 'job-1', deps), /cache reload failed/)

    assert.deepEqual(calls.deleteUpload, [payload.filePath])
    // -> A side effect failing after a successful import still means the job result was never set.
    assert.deepEqual(calls.setResult, [])
  })
})
