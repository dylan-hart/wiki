import { describe, test, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { replication } from './replication.ts'
import { installTestWiki } from '../test/mocks.ts'
import { ensureTemporal } from '../test/temporal.ts'

/**
 * `tick()` (the due-check driven by the `replicationTick` cron seed, see `models/jobs.ts`) and
 * `pull()` (the actual HTTP pull, run by `tasks/simple/replication-pull.ts`) exercised as pure units
 * -- no database, no real network. `fetch` and `WIKI.scheduler.addJob`/`WIKI.configSvc.saveToDb` are
 * stubbed, same `installTestWiki` + stubbed-`fetch` shape `tasks/simple/check-version.test.ts` uses.
 */

let wikiHandle: { restore(): void }
let previousFetch: typeof fetch
let addJob: ReturnType<typeof mock.fn>
let saveToDb: ReturnType<typeof mock.fn>
let tempDir: string

before(async () => {
  await ensureTemporal()
  previousFetch = globalThis.fetch
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'replication-test-'))
})

after(async () => {
  wikiHandle.restore()
  globalThis.fetch = previousFetch
  await fs.rm(tempDir, { recursive: true, force: true })
})

/** The `sites`/`groups`/`classificationLevels`/`glossary`/`assetServing` post-import side-effect
 *  models `pull()` reaches for once a restore succeeds (OpenProject #2517) -- separated out from
 *  `installWiki`'s per-test `models` override so a test can assert against them without repeating
 *  this shape. `restoredSites` mirrors what a successful `sites.getAllSites()` would answer with. */
const restoredSites = [{ id: 'site-1' }, { id: 'site-2' }]
let postImportCalls: {
  sitesBroadcastReload: number
  groupsBroadcastReload: number
  classificationLevelsBroadcastReload: number
  forgetAllPaths: number
  invalidateCache: string[]
}

function makePostImportModels() {
  postImportCalls = {
    sitesBroadcastReload: 0,
    groupsBroadcastReload: 0,
    classificationLevelsBroadcastReload: 0,
    forgetAllPaths: 0,
    invalidateCache: []
  }
  return {
    sites: {
      broadcastReload: mock.fn(async () => {
        postImportCalls.sitesBroadcastReload++
      }),
      getAllSites: mock.fn(async () => restoredSites)
    },
    groups: {
      broadcastReload: mock.fn(async () => {
        postImportCalls.groupsBroadcastReload++
      })
    },
    classificationLevels: {
      broadcastReload: mock.fn(async () => {
        postImportCalls.classificationLevelsBroadcastReload++
      })
    },
    glossary: {
      invalidateCache: mock.fn((siteId: string) => {
        postImportCalls.invalidateCache.push(siteId)
      })
    },
    assetServing: {
      forgetAllPaths: mock.fn(() => {
        postImportCalls.forgetAllPaths++
      })
    }
  }
}

function installWiki(config: Record<string, any> = {}, models: Record<string, any> = {}) {
  addJob = mock.fn(async () => ({ id: 'queued-job' }))
  saveToDb = mock.fn(async () => true)
  wikiHandle = installTestWiki({
    ROOTPATH: tempDir,
    config: { dataPath: '.', replication: config },
    scheduler: { addJob },
    configSvc: { saveToDb },
    models
  })
}

beforeEach(() => {
  installWiki()
})

describe('replication.tick', () => {
  test('does nothing when replication is disabled', async () => {
    installWiki({
      isEnabled: false,
      sourceUrl: 'https://prod.example.com',
      cronSchedule: '0 0 * * 0'
    })
    const queued = await replication.tick()
    assert.equal(queued, 0)
    assert.equal(addJob.mock.callCount(), 0)
  })

  test('does nothing when no source URL is configured', async () => {
    installWiki({ isEnabled: true, sourceUrl: '', cronSchedule: '0 0 * * 0' })
    const queued = await replication.tick()
    assert.equal(queued, 0)
    assert.equal(addJob.mock.callCount(), 0)
  })

  test('does nothing when no cron expression is configured', async () => {
    installWiki({ isEnabled: true, sourceUrl: 'https://prod.example.com', cronSchedule: '' })
    const queued = await replication.tick()
    assert.equal(queued, 0)
    assert.equal(addJob.mock.callCount(), 0)
  })

  test('queues a pull and records lastRunAt when never run before, mirroring Storage#tickScheduledSyncs (OpenProject #2437)', async () => {
    installWiki({
      isEnabled: true,
      sourceUrl: 'https://prod.example.com',
      bearerToken: 'tok',
      cronSchedule: '0 0 * * 0',
      lastRunAt: null
    })
    const queued = await replication.tick()
    assert.equal(queued, 1)
    assert.equal(addJob.mock.callCount(), 1)
    assert.equal((addJob.mock.calls[0]!.arguments[0] as any).task, 'replicationPull')
    assert.equal(saveToDb.mock.callCount(), 1)
    assert.ok(WIKI.config.replication.lastRunAt)
  })

  test('does not queue when the next scheduled fire is still in the future', async () => {
    const now = Temporal.Now.instant()
    installWiki({
      isEnabled: true,
      sourceUrl: 'https://prod.example.com',
      bearerToken: 'tok',
      // Weekly, and we just ran a moment ago -- the next occurrence is days out.
      cronSchedule: '0 0 * * 0',
      lastRunAt: now.toString({ smallestUnit: 'millisecond' })
    })
    const queued = await replication.tick(now)
    assert.equal(queued, 0)
    assert.equal(addJob.mock.callCount(), 0)
  })

  test('queues when the configured cron has a due occurrence since lastRunAt', async () => {
    const lastRunAt = Temporal.Now.instant().subtract({ hours: 26 })
    installWiki({
      isEnabled: true,
      sourceUrl: 'https://prod.example.com',
      bearerToken: 'tok',
      cronSchedule: '0 0 * * *', // daily at midnight UTC
      lastRunAt: lastRunAt.toString({ smallestUnit: 'millisecond' })
    })
    const queued = await replication.tick()
    assert.equal(queued, 1)
    assert.equal(addJob.mock.callCount(), 1)
  })

  test('logs a warning and skips an unparseable cron expression rather than throwing', async () => {
    installWiki({
      isEnabled: true,
      sourceUrl: 'https://prod.example.com',
      bearerToken: 'tok',
      cronSchedule: 'not a cron expression',
      lastRunAt: Temporal.Now.instant()
        .subtract({ hours: 26 })
        .toString({ smallestUnit: 'millisecond' })
    })
    const queued = await replication.tick()
    assert.equal(queued, 0)
    assert.equal(addJob.mock.callCount(), 0)
  })

  test('does not record a run when the scheduler declines to queue the job', async () => {
    installWiki({
      isEnabled: true,
      sourceUrl: 'https://prod.example.com',
      bearerToken: 'tok',
      cronSchedule: '0 0 * * 0',
      lastRunAt: null
    })
    addJob.mock.mockImplementation(async () => undefined)
    const queued = await replication.tick()
    assert.equal(queued, 0)
    assert.equal(saveToDb.mock.callCount(), 0)
  })
})

describe('replication.pull', () => {
  test('does nothing when replication is disabled', async () => {
    installWiki({ isEnabled: false })
    const fetchSpy = mock.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    await replication.pull()
    assert.equal(fetchSpy.mock.callCount(), 0)
  })

  test('does nothing when source URL or token is missing', async () => {
    installWiki({ isEnabled: true, sourceUrl: 'https://prod.example.com', bearerToken: '' })
    const fetchSpy = mock.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    await replication.pull()
    assert.equal(fetchSpy.mock.callCount(), 0)
  })

  test('downloads a completed export, hands it to the target-side import, and runs the shared post-import cache/index side effects (OpenProject #2489/#2490/#2517 contract)', async () => {
    const importSnapshot = mock.fn(async (_filePath: string) => {})
    installWiki(
      { isEnabled: true, sourceUrl: 'https://prod.example.com', bearerToken: 'tok' },
      { replicationImport: { importSnapshot }, ...makePostImportModels() }
    )
    let downloadCalls = 0
    globalThis.fetch = mock.fn(async (input: any) => {
      const url = String(input)
      if (url.endsWith('/_api/system/replication/export')) {
        return new Response(JSON.stringify({ id: 'export-job-1' }), { status: 200 })
      }
      if (url.includes('/_api/system/replication/export/export-job-1/download')) {
        downloadCalls++
        return new Response('fake-archive-bytes', { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    await replication.pull()

    assert.equal(downloadCalls, 1)
    assert.equal(importSnapshot.mock.callCount(), 1)
    const filePath = importSnapshot.mock.calls[0]!.arguments[0]
    assert.ok(filePath.endsWith('.tar.gz'))
    // -> The scratch file is cleaned up once the import has run, whether it succeeded or not.
    await assert.rejects(fs.access(filePath))

    // -> OpenProject #2517: a scheduled pull must reload the same caches and queue the same
    //    reindex jobs the manual-upload path already does, once the restore has actually succeeded.
    assert.equal(postImportCalls.sitesBroadcastReload, 1)
    assert.equal(postImportCalls.groupsBroadcastReload, 1)
    assert.equal(postImportCalls.classificationLevelsBroadcastReload, 1)
    assert.equal(postImportCalls.forgetAllPaths, 1)
    assert.deepEqual(postImportCalls.invalidateCache, ['site-1', 'site-2'])
    assert.deepEqual(
      addJob.mock.calls.map((c) => c.arguments[0]),
      [
        { task: 'rebuildSearchIndex', payload: { siteId: 'site-1' } },
        { task: 'rebuildSearchIndex', payload: { siteId: 'site-2' } }
      ]
    )
  })

  test('does not reload caches or queue a reindex when the import itself fails', async () => {
    const importSnapshot = mock.fn(async (_filePath: string) => {
      throw new Error('malformed replication archive')
    })
    installWiki(
      { isEnabled: true, sourceUrl: 'https://prod.example.com', bearerToken: 'tok' },
      { replicationImport: { importSnapshot }, ...makePostImportModels() }
    )
    globalThis.fetch = mock.fn(async (input: any) => {
      const url = String(input)
      if (url.endsWith('/_api/system/replication/export')) {
        return new Response(JSON.stringify({ id: 'export-job-1' }), { status: 200 })
      }
      return new Response('fake-archive-bytes', { status: 200 })
    }) as unknown as typeof fetch

    await assert.rejects(replication.pull(), /malformed replication archive/)

    assert.equal(postImportCalls.sitesBroadcastReload, 0)
    assert.equal(postImportCalls.groupsBroadcastReload, 0)
    assert.equal(postImportCalls.classificationLevelsBroadcastReload, 0)
    assert.equal(postImportCalls.forgetAllPaths, 0)
    assert.deepEqual(postImportCalls.invalidateCache, [])
    assert.equal(addJob.mock.callCount(), 0)
  })

  test('still cleans up the downloaded snapshot when a post-import side effect throws', async () => {
    const importSnapshot = mock.fn(async (_filePath: string) => {})
    const postImportModels = makePostImportModels()
    postImportModels.groups.broadcastReload = mock.fn(async () => {
      throw new Error('cache reload failed')
    })
    installWiki(
      { isEnabled: true, sourceUrl: 'https://prod.example.com', bearerToken: 'tok' },
      { replicationImport: { importSnapshot }, ...postImportModels }
    )
    globalThis.fetch = mock.fn(async (input: any) => {
      const url = String(input)
      if (url.endsWith('/_api/system/replication/export')) {
        return new Response(JSON.stringify({ id: 'export-job-1' }), { status: 200 })
      }
      return new Response('fake-archive-bytes', { status: 200 })
    }) as unknown as typeof fetch

    await assert.rejects(replication.pull(), /cache reload failed/)

    const filePath = importSnapshot.mock.calls[0]!.arguments[0]
    await assert.rejects(fs.access(filePath))
  })

  test('throws when the source instance refuses the export request', async () => {
    installWiki({ isEnabled: true, sourceUrl: 'https://prod.example.com', bearerToken: 'tok' })
    globalThis.fetch = mock.fn(
      async () => new Response('nope', { status: 403 })
    ) as unknown as typeof fetch
    await assert.rejects(replication.pull(), /refused the replication export request/)
  })

  test('throws when the download route answers with an unexpected status', async () => {
    installWiki({ isEnabled: true, sourceUrl: 'https://prod.example.com', bearerToken: 'tok' })
    globalThis.fetch = mock.fn(async (input: any) => {
      const url = String(input)
      if (url.endsWith('/_api/system/replication/export')) {
        return new Response(JSON.stringify({ id: 'export-job-1' }), { status: 200 })
      }
      return new Response('gone', { status: 404 })
    }) as unknown as typeof fetch
    await assert.rejects(replication.pull(), /download failed/)
  })

  test('throws a clear error when the target-side import (OpenProject #2490) is not yet installed', async () => {
    installWiki({ isEnabled: true, sourceUrl: 'https://prod.example.com', bearerToken: 'tok' }, {})
    globalThis.fetch = mock.fn(async (input: any) => {
      const url = String(input)
      if (url.endsWith('/_api/system/replication/export')) {
        return new Response(JSON.stringify({ id: 'export-job-1' }), { status: 200 })
      }
      return new Response('fake-archive-bytes', { status: 200 })
    }) as unknown as typeof fetch

    await assert.rejects(replication.pull(), /Replication import is not available/)
  })
})
