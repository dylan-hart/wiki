import { describe, test, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { task } from './import-content.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * Exercises the task's control flow — including the four post-import cache/index side effects
 * (OpenProject #1713) — against fake `siteImport`/`groups`/`glossary`/`assetServing`/`jobs` models and a fake
 * `addJob`, not a real database. See `task()`'s `deps` parameter, the same convention
 * `dispatch-storage.test.ts` uses.
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

const payload = { filePath: '/tmp/upload.tar.gz', targetSiteId: 'site-1', importedById: 'user-1' }
const importResult = { pages: 3, tree: 4, assets: 2, groups: 1 }

function makeDeps(overrides: Partial<Parameters<typeof task>[2]> = {}) {
  const calls = {
    importSite: [] as any[],
    broadcastReload: 0,
    invalidateCache: [] as any[],
    forgetAllPaths: 0,
    addJob: [] as any[],
    setResult: [] as any[],
    deleteUpload: [] as any[]
  }
  const deps = {
    siteImport: {
      importSite: mock.fn(async (...args: any[]) => {
        calls.importSite.push(args)
        return importResult
      }),
      deleteUpload: mock.fn(async (filePath: string) => {
        calls.deleteUpload.push(filePath)
      })
    } as any,
    groups: {
      broadcastReload: mock.fn(async () => {
        calls.broadcastReload++
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
      return { id: 'job-2' }
    }),
    ...overrides
  }
  return { deps, calls }
}

describe('import-content.task', () => {
  test('reloads caches and queues a search rebuild exactly once after a successful import', async () => {
    const { deps, calls } = makeDeps()

    await task(payload, 'job-1', deps)

    assert.equal(calls.importSite.length, 1)
    assert.deepEqual(calls.importSite[0], [
      payload.filePath,
      payload.targetSiteId,
      payload.importedById
    ])

    // -> Rules reload: broadcasting, not just a local reload, so every cluster instance's
    //    `rulesCache` picks up the imported/updated groups.
    assert.equal(calls.broadcastReload, 1)

    // -> Glossary cache invalidated for exactly the target site.
    assert.deepEqual(calls.invalidateCache, [payload.targetSiteId])

    // -> Asset path cache dropped wholesale.
    assert.equal(calls.forgetAllPaths, 1)

    // -> Search rebuild is queued, not run inline: the task's own dependency surface has no
    //    `search.rebuild` to call — only `addJob` — so an inline rebuild isn't even reachable here.
    assert.equal(calls.addJob.length, 1)
    assert.deepEqual(calls.addJob[0], {
      task: 'rebuildSearchIndex',
      payload: { siteId: payload.targetSiteId }
    })

    // -> Job result is still recorded, after the side effects.
    assert.deepEqual(calls.setResult, [['job-1', importResult]])

    // -> Upload is cleaned up on success too.
    assert.deepEqual(calls.deleteUpload, [payload.filePath])
  })

  test('does not reload caches, invalidate the glossary, forget asset paths, or queue a rebuild when the import itself fails', async () => {
    const { deps, calls } = makeDeps({
      siteImport: {
        importSite: mock.fn(async () => {
          throw new Error('malformed archive')
        }),
        deleteUpload: mock.fn(async (filePath: string) => {
          calls.deleteUpload.push(filePath)
        })
      } as any
    })

    await assert.rejects(() => task(payload, 'job-1', deps), /malformed archive/)

    assert.equal(calls.broadcastReload, 0)
    assert.deepEqual(calls.invalidateCache, [])
    assert.equal(calls.forgetAllPaths, 0)
    assert.deepEqual(calls.addJob, [])
    assert.deepEqual(calls.setResult, [])

    // -> The uploaded working file is still cleaned up on failure, unlike the cache/index side effects.
    assert.deepEqual(calls.deleteUpload, [payload.filePath])
  })

  test('still deletes the upload when a post-import side effect throws', async () => {
    const { deps, calls } = makeDeps({
      groups: {
        broadcastReload: mock.fn(async () => {
          throw new Error('cache reload failed')
        })
      } as any
    })

    await assert.rejects(() => task(payload, 'job-1', deps), /cache reload failed/)

    assert.deepEqual(calls.deleteUpload, [payload.filePath])
    // -> A side effect failing after a successful import still means the job result was never set.
    assert.deepEqual(calls.setResult, [])
  })
})
