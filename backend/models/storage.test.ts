import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureTemporal } from '../test/temporal.ts'
import { getFileExtension, isIsoDuration, storage, SYNC_SHAPED_ACTIONS } from './storage.ts'
import { sites as sitesTable } from '../db/schema.ts'
import type { StorageTarget } from './storage.ts'

// -> `refreshFromDisk()` reads the real files under `modules/storage`, so `SERVERPATH` has to point
//    at this checkout's `backend/`. No database is involved.
before(async () => {
  await ensureTemporal()
  global.CARDINAL = {
    SERVERPATH: path.join(import.meta.dirname, '..'),
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {}
    }
  } as unknown as CardinalGlobal
  await storage.refreshFromDisk()
})

test('SYNC_SHAPED_ACTIONS names exactly the actions api/storage.ts queues instead of running inline', () => {
  assert.deepEqual([...SYNC_SHAPED_ACTIONS].sort(), ['importAll', 'sync', 'syncUntracked'].sort())
})

test('refreshFromDisk reads sync-mode config from each definition.yml', () => {
  assert.ok(storage.definitions.length > 0, 'expected at least one storage definition')

  const git = storage.getDefinition('git')!
  assert.deepEqual(git.supportedModes, ['sync', 'push', 'pull'])
  assert.equal(git.defaultMode, 'sync')
  assert.equal(git.schedule, 'PT5M')

  const disk = storage.getDefinition('disk')!
  assert.deepEqual(disk.supportedModes, ['push'])
  assert.equal(disk.defaultMode, 'push')
  assert.equal(disk.schedule, false)
})

test('the db module has a storage.ts implementation, so its purge action is offered', () => {
  const db = storage.getDefinition('db')!
  assert.equal(db.hasImplementation, true)
  assert.deepEqual(
    db.actions.map((action) => action.handler),
    ['purge']
  )
})

test('the disk module has a storage.ts implementation, so its dump/backup/importAll actions are offered', () => {
  const disk = storage.getDefinition('disk')!
  assert.equal(disk.hasImplementation, true)
  assert.deepEqual(
    disk.actions.map((action) => action.handler),
    ['dump', 'backup', 'importAll']
  )
})

function makeTarget(moduleKey: string): StorageTarget {
  const definition = storage.getDefinition(moduleKey)!
  return {
    id: '00000000-0000-0000-0000-000000000000',
    siteId: 'site-1',
    module: moduleKey,
    isEnabled: true,
    title: definition.title,
    description: definition.description,
    icon: definition.icon,
    banner: definition.banner,
    vendor: definition.vendor,
    website: definition.website,
    contentTypes: { activeTypes: [], largeThreshold: '5MB' },
    assetDelivery: {
      isStreamingSupported: false,
      isDirectAccessSupported: false,
      streaming: false,
      directAccess: false
    },
    versioning: { isSupported: false, isForceEnabled: false, enabled: false },
    sync: {
      supportedModes: definition.supportedModes,
      schedule: definition.schedule,
      mode: definition.defaultMode,
      scheduleOverride: null,
      supportsContentSync: definition.supportsContentSync
    },
    props: definition.props,
    config: {},
    actions: []
  }
}

test("validateTarget rejects a sync mode outside the module's supportedModes", async () => {
  const target = makeTarget('git')
  const invalid = await storage.validateTarget(target, {
    id: target.id,
    sync: { mode: 'teleport' }
  })
  assert.match(invalid ?? '', /not a valid sync mode/)
})

test('validateTarget accepts a sync mode change for a multi-mode module', async () => {
  const target = makeTarget('git')
  const invalid = await storage.validateTarget(target, { id: target.id, sync: { mode: 'push' } })
  assert.equal(invalid, null)
})

test('validateTarget rejects a sync mode change for a single-mode module', async () => {
  const target = makeTarget('disk')
  const invalid = await storage.validateTarget(target, { id: target.id, sync: { mode: 'push' } })
  assert.match(invalid ?? '', /does not support changing/)
})

test('validateTarget rejects a malformed scheduleOverride', async () => {
  const target = makeTarget('git')
  const invalid = await storage.validateTarget(target, {
    id: target.id,
    sync: { scheduleOverride: 'not-a-duration' }
  })
  assert.match(invalid ?? '', /not a valid ISO-8601 duration/)
})

test('validateTarget rejects a scheduleOverride on an event-only module', async () => {
  const target = makeTarget('disk')
  const invalid = await storage.validateTarget(target, {
    id: target.id,
    sync: { scheduleOverride: 'PT10M' }
  })
  assert.match(invalid ?? '', /does not sync on a schedule/)
})

test('validateTarget accepts a valid scheduleOverride on a scheduled module', async () => {
  const target = makeTarget('git')
  const invalid = await storage.validateTarget(target, {
    id: target.id,
    sync: { scheduleOverride: 'PT10M' }
  })
  assert.equal(invalid, null)
})

test('validateTarget accepts clearing a scheduleOverride', async () => {
  const target = makeTarget('git')
  target.sync.scheduleOverride = 'PT10M'
  const invalid = await storage.validateTarget(target, {
    id: target.id,
    sync: { scheduleOverride: null }
  })
  assert.equal(invalid, null)
})

test('validateTarget accepts a cron-expression scheduleOverride', async () => {
  const target = makeTarget('git')
  const invalid = await storage.validateTarget(target, {
    id: target.id,
    // -> a pinned time of day + day-of-week restriction -- a shape no ISO-8601 duration can express
    sync: { scheduleOverride: '30 9 * * 1' }
  })
  assert.equal(invalid, null)
})

test('validateTarget rejects a scheduleOverride that is neither a duration nor a valid cron expression', async () => {
  const target = makeTarget('git')
  const invalid = await storage.validateTarget(target, {
    id: target.id,
    sync: { scheduleOverride: 'not-a-duration' }
  })
  assert.match(invalid ?? '', /not a valid ISO-8601 duration or cron expression/)
})

test('validateTarget rejects a calendar-length or otherwise inexact duration scheduleOverride', async () => {
  const target = makeTarget('git')
  for (const scheduleOverride of ['P1Y', 'P1M', 'P1Y2M', 'P1M1D', 'P1W', '-PT5M', 'P1.5D']) {
    const invalid = await storage.validateTarget(target, {
      id: target.id,
      sync: { scheduleOverride }
    })
    assert.match(
      invalid ?? '',
      /not a valid ISO-8601 duration or cron expression/,
      scheduleOverride
    )
  }
})

test('validateTarget still accepts every exact-length duration shape', async () => {
  const target = makeTarget('git')
  for (const scheduleOverride of ['PT5M', 'P1D', 'P1DT12H', 'PT0.5S', 'PT1H30M']) {
    const invalid = await storage.validateTarget(target, {
      id: target.id,
      sync: { scheduleOverride }
    })
    assert.equal(invalid, null, scheduleOverride)
  }
})

test('isIsoDuration accepts only durations with an exact length', () => {
  assert.equal(isIsoDuration('PT5M'), true)
  assert.equal(isIsoDuration('P1DT12H'), true)
  assert.equal(isIsoDuration('P1M'), false)
  assert.equal(isIsoDuration('P1Y'), false)
  assert.equal(isIsoDuration('P1W'), false)
  assert.equal(isIsoDuration('P'), false)
  assert.equal(isIsoDuration('PT'), false)
  assert.equal(isIsoDuration('30 9 * * 1'), false)
})

test('validateTarget rejects enabling the disk target with a relative path', async () => {
  const target = makeTarget('disk')
  const invalid = await storage.validateTarget(target, {
    id: target.id,
    isEnabled: true,
    config: { path: 'relative/path' }
  })
  assert.match(invalid ?? '', /not an absolute path/)
})

test('validateTarget rejects enabling the disk target with a path that does not exist', async () => {
  const target = makeTarget('disk')
  const invalid = await storage.validateTarget(target, {
    id: target.id,
    isEnabled: true,
    config: { path: path.join(os.tmpdir(), `wiki-disk-validate-missing-${Date.now()}`) }
  })
  assert.match(invalid ?? '', /does not exist/)
})

test('validateTarget accepts enabling the disk target with an absolute, existing, writable path', async () => {
  const target = makeTarget('disk')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-disk-validate-'))
  try {
    const invalid = await storage.validateTarget(target, {
      id: target.id,
      isEnabled: true,
      config: { path: dir }
    })
    assert.equal(invalid, null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('validateTarget rejects saving disk config with a path that is a file, not a directory', async () => {
  const target = makeTarget('disk')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-disk-validate-'))
  const filePath = path.join(dir, 'not-a-dir')
  await fs.writeFile(filePath, 'x')
  try {
    const invalid = await storage.validateTarget(target, {
      id: target.id,
      config: { path: filePath }
    })
    assert.match(invalid ?? '', /not a directory/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('validateTarget skips the deep disk path check when neither config nor isEnabled changes', async () => {
  // -> `makeTarget`'s disk target has no `path` at all, so the deep check would reject if it ran --
  //    which is what makes a `null` result here proof that it did not.
  const target = makeTarget('disk')
  const invalid = await storage.validateTarget(target, {
    id: target.id,
    sync: { mode: undefined }
  })
  assert.equal(invalid, null)
})

/**
 * `getSiteTargets` merges the row with the module's own definition, so `moduleKey` has to name a
 * module that really exists on disk.
 */
function makeRow(
  moduleKey: string,
  overrides: {
    isEnabled?: boolean
    activeTypes?: string[]
    largeThreshold?: string
    syncMode?: string
  } = {}
) {
  return {
    id: `target-${moduleKey}`,
    siteId: 'site-1',
    module: moduleKey,
    isEnabled: overrides.isEnabled ?? true,
    contentTypes: {
      activeTypes: overrides.activeTypes ?? [],
      largeThreshold: overrides.largeThreshold ?? '5MB'
    },
    assetDelivery: { streaming: false, directAccess: false },
    versioning: { enabled: false },
    syncMode: overrides.syncMode ?? storage.getDefinition(moduleKey)!.defaultMode,
    scheduleOverride: null,
    config: {},
    state: {}
  }
}

/**
 * The `select().from().where()` chain and `scheduler.addJob` are the whole `CARDINAL` surface
 * `dispatch()` touches, so faking both is enough to run it with no database or queue.
 */
function fakeDispatchDeps(rows: object[]) {
  const jobs: { task: string; payload: Record<string, any> }[] = []
  global.CARDINAL = {
    ...global.CARDINAL,
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) })
    },
    scheduler: {
      addJob: async (opts: { task: string; payload: Record<string, any> }) => {
        jobs.push(opts)
        return { id: `job-${jobs.length}` }
      }
    }
  } as unknown as CardinalGlobal
  return jobs
}

test('getSiteTargets threads the siteId argument onto every target it returns', async () => {
  fakeDispatchDeps([makeRow('git'), makeRow('disk')])
  const targets = await storage.getSiteTargets('site-1')
  assert.ok(targets.length >= 2, 'expected at least the git and disk targets')
  for (const target of targets) {
    assert.equal(target.siteId, 'site-1')
  }
})

test('getSiteTargetById returns a target whose siteId matches the site it was fetched for', async () => {
  fakeDispatchDeps([makeRow('git')])
  const target = await storage.getSiteTargetById('site-1', 'target-git')
  assert.equal(target?.siteId, 'site-1')
})

test('dispatch skips a pull-only target even when it covers the content type', async () => {
  const jobs = fakeDispatchDeps([makeRow('git', { activeTypes: ['pages'], syncMode: 'pull' })])
  const queued = await storage.dispatch('page:create', { id: 'p1', siteId: 'site-1' })
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

test('dispatch queues a job for an enabled sync target covering a page event', async () => {
  const jobs = fakeDispatchDeps([makeRow('git', { activeTypes: ['pages'], syncMode: 'sync' })])
  const queued = await storage.dispatch('page:create', {
    id: 'p1',
    siteId: 'site-1',
    path: 'home'
  })
  assert.equal(queued, 1)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].task, 'dispatchStorage')
  assert.equal(jobs[0].payload.targetId, 'target-git')
  assert.equal(jobs[0].payload.contentType, 'page')
  assert.equal(jobs[0].payload.contentId, 'p1')
  assert.equal(jobs[0].payload.handler, 'created')
  assert.deepEqual(jobs[0].payload.data, { id: 'p1', siteId: 'site-1', path: 'home' })
})

test('dispatch skips a disabled target', async () => {
  const jobs = fakeDispatchDeps([
    makeRow('git', { activeTypes: ['pages'], syncMode: 'sync', isEnabled: false })
  ])
  const queued = await storage.dispatch('page:create', { id: 'p1', siteId: 'site-1' })
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

test("dispatch skips a target whose activeTypes doesn't cover the asset's kind", async () => {
  const jobs = fakeDispatchDeps([makeRow('s3', { activeTypes: ['documents'], syncMode: 'push' })])
  const queued = await storage.dispatch('asset:upload', {
    id: 'a1',
    siteId: 'site-1',
    kind: 'image',
    fileSize: 100
  })
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

test('dispatch maps asset:edit to the assetUploaded handler', async () => {
  const jobs = fakeDispatchDeps([makeRow('s3', { activeTypes: ['images'], syncMode: 'push' })])
  const queued = await storage.dispatch('asset:edit', {
    id: 'a1',
    siteId: 'site-1',
    kind: 'image',
    fileSize: 100
  })
  assert.equal(queued, 1)
  assert.equal(jobs[0].payload.handler, 'assetUploaded')
})

// -> Without a `STORAGE_HANDLERS` entry for `asset:move`, a moved asset's stale copy is never
//    cleaned up on a blob or git target.
test('dispatch maps asset:move to the assetMoved handler, carrying previousFolderPath through', async () => {
  const jobs = fakeDispatchDeps([makeRow('s3', { activeTypes: ['images'], syncMode: 'push' })])
  const queued = await storage.dispatch('asset:move', {
    id: 'a1',
    siteId: 'site-1',
    fileName: 'pic.png',
    folderPath: 'gallery',
    previousFolderPath: 'images',
    kind: 'image',
    fileSize: 100
  })
  assert.equal(queued, 1)
  assert.equal(jobs[0].payload.handler, 'assetMoved')
  assert.equal(jobs[0].payload.data.previousFolderPath, 'images')
  assert.equal(jobs[0].payload.data.folderPath, 'gallery')
})

test("dispatch classifies an asset over a target's own largeThreshold as large", async () => {
  fakeDispatchDeps([
    makeRow('s3', { activeTypes: ['large'], largeThreshold: '1KB', syncMode: 'push' })
  ])
  const queued = await storage.dispatch('asset:upload', {
    id: 'a1',
    siteId: 'site-1',
    kind: 'image',
    fileSize: 2048
  })
  assert.equal(queued, 1)
})

test("dispatch does not classify a small asset as large, even when only 'large' is active", async () => {
  const jobs = fakeDispatchDeps([
    makeRow('s3', { activeTypes: ['large'], largeThreshold: '1KB', syncMode: 'push' })
  ])
  const queued = await storage.dispatch('asset:upload', {
    id: 'a1',
    siteId: 'site-1',
    kind: 'image',
    fileSize: 10
  })
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

// -> dispatch's large-file classification must agree with the blob targets' own
//    (`helpers/blobTarget.ts`) on both decimal thresholds and the boundary.
test('dispatch classifies an asset at exactly the largeThreshold as large (an at-or-above boundary, not strictly over)', async () => {
  fakeDispatchDeps([
    makeRow('s3', { activeTypes: ['large'], largeThreshold: '1KB', syncMode: 'push' })
  ])
  const queued = await storage.dispatch('asset:upload', {
    id: 'a1',
    siteId: 'site-1',
    kind: 'image',
    fileSize: 1024
  })
  assert.equal(queued, 1)
})

test('dispatch classifies an asset over a decimal largeThreshold (e.g. "2.5MB") as large', async () => {
  fakeDispatchDeps([
    makeRow('s3', { activeTypes: ['large'], largeThreshold: '2.5MB', syncMode: 'push' })
  ])
  const queued = await storage.dispatch('asset:upload', {
    id: 'a1',
    siteId: 'site-1',
    kind: 'image',
    fileSize: 3 * 1024 * 1024
  })
  assert.equal(queued, 1)
})

test('dispatch does not classify an asset under a decimal largeThreshold as large', async () => {
  const jobs = fakeDispatchDeps([
    makeRow('s3', { activeTypes: ['large'], largeThreshold: '2.5MB', syncMode: 'push' })
  ])
  const queued = await storage.dispatch('asset:upload', {
    id: 'a1',
    siteId: 'site-1',
    kind: 'image',
    fileSize: 2 * 1024 * 1024
  })
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

test('dispatch is a no-op for an event with no storage handler', async () => {
  const jobs = fakeDispatchDeps([makeRow('git', { activeTypes: ['pages'], syncMode: 'sync' })])
  const queued = await storage.dispatch('comment:new' as any, { id: 'c1', siteId: 'site-1' })
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

test('dispatch is a no-op without a siteId or a content id', async () => {
  const jobs = fakeDispatchDeps([makeRow('git', { activeTypes: ['pages'], syncMode: 'sync' })])
  assert.equal(await storage.dispatch('page:create', { id: 'p1' }), 0)
  assert.equal(await storage.dispatch('page:create', { siteId: 'site-1' }), 0)
  assert.equal(jobs.length, 0)
})

test('dispatch never queues a job for a module with no write-path content handlers', async () => {
  // -> Content-type coverage and sync mode both match here, so only the handler-support check can
  //    be stopping the queue: `disk` implements manual actions and config validation, no content
  //    handlers.
  const jobs = fakeDispatchDeps([makeRow('disk', { activeTypes: ['images'], syncMode: 'push' })])
  const queued = await storage.dispatch('asset:upload', {
    id: 'a1',
    siteId: 'site-1',
    kind: 'image',
    fileSize: 100
  })
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

test('getSiteTargets reports supportsContentSync per module', async () => {
  fakeDispatchDeps([makeRow('git'), makeRow('disk')])
  const targets = await storage.getSiteTargets('site-1')
  const git = targets.find((t) => t.module === 'git')
  const disk = targets.find((t) => t.module === 'disk')
  // -> git implements the content handlers; disk implements none of them
  assert.equal(git?.sync.supportsContentSync, true)
  assert.equal(disk?.sync.supportsContentSync, false)
})

function makeTickRow(
  moduleKey: string,
  overrides: { syncMode?: string; scheduleOverride?: string | null; lastTickAt?: Date | null } = {}
) {
  return {
    id: `target-${moduleKey}`,
    siteId: 'site-1',
    module: moduleKey,
    isEnabled: true,
    syncMode: overrides.syncMode ?? storage.getDefinition(moduleKey)!.defaultMode,
    scheduleOverride: overrides.scheduleOverride ?? null,
    lastTickAt: overrides.lastTickAt ?? null
  }
}

/**
 * The recorded `update().set()` values are how a test sees whether `lastTickAt` was advanced;
 * `addJobSucceeds: false` reproduces a queue that refused the job.
 */
function fakeTickDeps(
  rows: object[],
  { addJobSucceeds = true }: { addJobSucceeds?: boolean } = {}
) {
  const jobs: { task: string; payload: Record<string, any> }[] = []
  const updates: { values: Record<string, any> }[] = []
  global.CARDINAL = {
    ...global.CARDINAL,
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
      update: () => ({
        set: (values: Record<string, any>) => ({
          where: () => {
            updates.push({ values })
            return Promise.resolve()
          }
        })
      })
    },
    scheduler: {
      addJob: async (opts: { task: string; payload: Record<string, any> }) => {
        jobs.push(opts)
        return addJobSucceeds ? { id: `job-${jobs.length}` } : undefined
      }
    }
  } as unknown as CardinalGlobal
  return { jobs, updates }
}

test('tickScheduledSyncs skips a push-only module even though it is enabled', async () => {
  const { jobs } = fakeTickDeps([makeTickRow('disk', { syncMode: 'push' })])
  const queued = await storage.tickScheduledSyncs()
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

test('tickScheduledSyncs skips a scheduled module whose target is explicitly set to push mode', async () => {
  const { jobs } = fakeTickDeps([makeTickRow('git', { syncMode: 'push' })])
  const queued = await storage.tickScheduledSyncs()
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

test('tickScheduledSyncs queues a due target that has never ticked, as a target-level sync job', async () => {
  const { jobs, updates } = fakeTickDeps([makeTickRow('git', { syncMode: 'sync' })])
  const queued = await storage.tickScheduledSyncs()
  assert.equal(queued, 1)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].task, 'dispatchStorage')
  assert.equal(jobs[0].payload.targetId, 'target-git')
  assert.equal(jobs[0].payload.siteId, 'site-1')
  assert.equal(jobs[0].payload.handler, 'sync')
  assert.deepEqual(jobs[0].payload.data, {})
  assert.equal(jobs[0].payload.contentType, undefined)
  assert.equal(jobs[0].payload.contentId, undefined)
  assert.equal(updates.length, 1)
  assert.ok(updates[0].values.lastTickAt instanceof Date)
})

test('tickScheduledSyncs skips a target whose schedule has not elapsed yet', async () => {
  const now = Temporal.Now.instant()
  const lastTickAt = new Date(now.subtract({ minutes: 1 }).epochMilliseconds)
  const { jobs } = fakeTickDeps([makeTickRow('git', { syncMode: 'sync', lastTickAt })])
  const queued = await storage.tickScheduledSyncs(now)
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

test("tickScheduledSyncs queues a target once its module's schedule has elapsed", async () => {
  const now = Temporal.Now.instant()
  const lastTickAt = new Date(now.subtract({ minutes: 6 }).epochMilliseconds)
  const { jobs } = fakeTickDeps([makeTickRow('git', { syncMode: 'sync', lastTickAt })])
  const queued = await storage.tickScheduledSyncs(now)
  assert.equal(queued, 1)
  assert.equal(jobs.length, 1)
})

test("tickScheduledSyncs honors a target's own scheduleOverride over the module's declared schedule", async () => {
  const now = Temporal.Now.instant()
  const lastTickAt = new Date(now.subtract({ minutes: 2 }).epochMilliseconds)
  // -> git's module schedule is PT5M, so 2 minutes elapsed would not be due on its own; the
  //    target's PT1M override is the only thing that can make it due
  const { jobs } = fakeTickDeps([
    makeTickRow('git', { syncMode: 'sync', scheduleOverride: 'PT1M', lastTickAt })
  ])
  const queued = await storage.tickScheduledSyncs(now)
  assert.equal(queued, 1)
  assert.equal(jobs.length, 1)
})

/**
 * `scheduleOverride` is re-read off the row on every tick — no per-target cron job bakes the
 * interval in at boot — so a shortened interval applies without waiting out however much of the
 * old, longer one had already elapsed.
 */
test('tickScheduledSyncs picks up a shortened scheduleOverride on its very next tick, no restart needed', async () => {
  const t0 = Temporal.Now.instant()
  const lastTickAt = new Date(t0.epochMilliseconds)
  const rows = [makeTickRow('git', { syncMode: 'sync', scheduleOverride: 'PT1H', lastTickAt })]

  const { jobs: jobsBefore } = fakeTickDeps(rows)
  const queuedBefore = await storage.tickScheduledSyncs(t0.add({ seconds: 30 }))
  assert.equal(queuedBefore, 0)
  assert.equal(jobsBefore.length, 0)

  // -> The same row, freshly read, not a new target.
  rows[0].scheduleOverride = 'PT1M'
  const { jobs: jobsAfter } = fakeTickDeps(rows)
  const queuedAfter = await storage.tickScheduledSyncs(t0.add({ seconds: 65 }))
  assert.equal(queuedAfter, 1)
  assert.equal(jobsAfter.length, 1)
})

test('tickScheduledSyncs does not advance lastTickAt when the job fails to queue', async () => {
  const { jobs, updates } = fakeTickDeps([makeTickRow('git', { syncMode: 'sync' })], {
    addJobSucceeds: false
  })
  const queued = await storage.tickScheduledSyncs()
  assert.equal(queued, 0)
  assert.equal(jobs.length, 1)
  assert.equal(updates.length, 0)
})

/**
 * `lastTickAt` records when a sync was last *queued*, never whether it completed, so the tick has no
 * notion of a remote having been unreachable and nothing suspends the schedule. Job-level retry is
 * the scheduler's own concern.
 */
test('tickScheduledSyncs re-queues a target on schedule regardless of how many prior ticks were never actually retried — auto-resume needs no state to restore', async () => {
  const now = Temporal.Now.instant()
  const dueAgo = new Date(now.subtract({ minutes: 10 }).epochMilliseconds)
  const { jobs, updates } = fakeTickDeps([
    makeTickRow('git', { syncMode: 'sync', scheduleOverride: 'PT5M', lastTickAt: dueAgo })
  ])
  const queued = await storage.tickScheduledSyncs(now)
  assert.equal(queued, 1)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].payload.handler, 'sync')
  assert.ok(updates[0].values.lastTickAt instanceof Date)
})

test('tickScheduledSyncs logs and skips a target with an unparseable schedule override, without throwing', async () => {
  const { jobs } = fakeTickDeps([
    makeTickRow('git', { syncMode: 'sync', scheduleOverride: 'not-a-duration' })
  ])
  const queued = await storage.tickScheduledSyncs()
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

test('tickScheduledSyncs queues a target that has never ticked with a cron scheduleOverride, same as a duration', async () => {
  const { jobs } = fakeTickDeps([
    makeTickRow('git', { syncMode: 'sync', scheduleOverride: '30 9 * * 1' })
  ])
  const queued = await storage.tickScheduledSyncs()
  assert.equal(queued, 1)
  assert.equal(jobs.length, 1)
})

test('tickScheduledSyncs skips a cron-override target whose next occurrence has not arrived yet', async () => {
  // -> "every day at 09:30" -- pin `now` to 09:00 the same day, an hour after a midnight tick, so
  //    the next 09:30 occurrence is still 30 minutes out.
  const now = Temporal.Instant.from('2026-09-14T09:00:00Z')
  const lastTickAt = new Date(Temporal.Instant.from('2026-09-14T00:00:00Z').epochMilliseconds)
  const { jobs } = fakeTickDeps([
    makeTickRow('git', { syncMode: 'sync', scheduleOverride: '30 9 * * *', lastTickAt })
  ])
  const queued = await storage.tickScheduledSyncs(now)
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

test('tickScheduledSyncs queues a cron-override target once its next occurrence has passed', async () => {
  const now = Temporal.Instant.from('2026-09-14T09:31:00Z')
  const lastTickAt = new Date(Temporal.Instant.from('2026-09-14T00:00:00Z').epochMilliseconds)
  const { jobs, updates } = fakeTickDeps([
    makeTickRow('git', { syncMode: 'sync', scheduleOverride: '30 9 * * *', lastTickAt })
  ])
  const queued = await storage.tickScheduledSyncs(now)
  assert.equal(queued, 1)
  assert.equal(jobs.length, 1)
  assert.ok(updates[0].values.lastTickAt instanceof Date)
})

test('tickScheduledSyncs does not re-queue a cron-override target exactly at its own last-ticked occurrence', async () => {
  // -> lastTickAt is itself the 09:30 occurrence -- there is no *further* occurrence yet at the
  //    same instant, matching the duration branch's exclusive-of-the-tick-that-just-happened math.
  const occurrence = Temporal.Instant.from('2026-09-14T09:30:00Z')
  const lastTickAt = new Date(occurrence.epochMilliseconds)
  const { jobs } = fakeTickDeps([
    makeTickRow('git', { syncMode: 'sync', scheduleOverride: '30 9 * * *', lastTickAt })
  ])
  const queued = await storage.tickScheduledSyncs(occurrence)
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

test('tickScheduledSyncs logs and skips a target with a cron scheduleOverride that is invalid', async () => {
  const { jobs } = fakeTickDeps([
    makeTickRow('git', { syncMode: 'sync', scheduleOverride: 'not a cron either' })
  ])
  const queued = await storage.tickScheduledSyncs()
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})

const silentLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

describe('storage / validateConfig, validateTarget (pure, real s3 definition read from disk)', () => {
  let previousWiki: CardinalGlobal

  before(async () => {
    // -> Captured here, not at describe-body-eval time: `describe()` bodies run during test
    //    collection, before the file-level `before()` above has set `global.CARDINAL` at all.
    previousWiki = global.CARDINAL
    ;(globalThis as any).CARDINAL = {
      SERVERPATH: path.join(import.meta.dirname, '..'),
      logger: silentLogger
    }
    await storage.refreshFromDisk()
  })

  after(() => {
    // -> Restored rather than deleted: the bare `runDailyBackups` tests below this describe run
    //    against that same global and need it back in place.
    global.CARDINAL = previousWiki
  })

  test('the s3 definition loaded for real, with its declared props intact', () => {
    const definition = storage.getDefinition('s3')
    assert.ok(definition, 'expected modules/storage/s3/definition.yml to have loaded')
    assert.ok(definition!.props.mode, 'expected a `mode` prop')
    assert.ok(definition!.props.awsRegion, 'expected an `awsRegion` prop')
  })

  test('an invalid enum value for `mode` is rejected with a readable message', () => {
    const invalid = storage.validateConfig('s3', { mode: 'gcp' })
    assert.match(invalid ?? '', /"gcp" is not a valid value for Mode/)
  })

  test('a mode-gated enum prop is still validated against its own enum regardless of the current mode', () => {
    // -> `awsRegion` is only shown in the admin area `if mode eq aws` (definition.yml), but
    //    `validateConfig` has no notion of that UI gate — it validates every incoming key against
    //    its own prop declaration, so a bogus `awsRegion` is refused even while `mode` is `do`.
    const invalid = storage.validateConfig('s3', { mode: 'do', awsRegion: 'mars-central-1' })
    assert.match(invalid ?? '', /"mars-central-1" is not a valid value for Region/)
  })

  test('a boolean prop refuses a non-boolean value', () => {
    const invalid = storage.validateConfig('s3', { s3ForcePathStyle: 'true' })
    assert.match(invalid ?? '', /Force Path Style for S3 objects must be true or false/)
  })

  test('an unknown key is silently accepted (dropped by buildConfig, not refused here)', () => {
    assert.equal(storage.validateConfig('s3', { notARealProp: 'whatever' }), null)
  })

  test('a fully valid aws-mode config passes', () => {
    assert.equal(
      storage.validateConfig('s3', {
        mode: 'aws',
        awsRegion: 'us-east-1',
        bucket: 'my-bucket',
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        storageTier: 'STANDARD'
      }),
      null
    )
  })

  test('buildConfig drops a sensitive value that is just the mask echoed back, keeping the real existing one', () => {
    const config = storage.buildConfig(
      's3',
      { secretAccessKey: '********', bucket: 'new-bucket' },
      { secretAccessKey: 'real-existing-secret', bucket: 'old-bucket' }
    )
    assert.equal(config.secretAccessKey, 'real-existing-secret')
    assert.equal(config.bucket, 'new-bucket')
  })

  test('buildConfig accepts a genuinely new sensitive value that happens not to be the mask', () => {
    const config = storage.buildConfig(
      's3',
      { secretAccessKey: 'brand-new-secret' },
      { secretAccessKey: 'old-secret' }
    )
    assert.equal(config.secretAccessKey, 'brand-new-secret')
  })

  test('validateTarget rejects an unknown content type', async () => {
    const definition = storage.getDefinition('s3')!
    const target = {
      id: 't1',
      siteId: 'site-1',
      module: 's3',
      title: definition.title,
      contentTypes: { activeTypes: [], largeThreshold: '5MB' }
    } as any
    const invalid = await storage.validateTarget(target, {
      id: 't1',
      contentTypes: { activeTypes: ['videos'] }
    })
    assert.match(invalid ?? '', /"videos" is not a valid content type/)
  })

  test('validateTarget rejects a malformed largeThreshold', async () => {
    const target = {
      id: 't1',
      siteId: 'site-1',
      module: 's3',
      title: 'S3',
      contentTypes: { activeTypes: [], largeThreshold: '5MB' }
    } as any
    const invalid = await storage.validateTarget(target, {
      id: 't1',
      contentTypes: { largeThreshold: 'huge' }
    })
    assert.match(invalid ?? '', /"huge" is not a valid size threshold/)
  })

  test('validateTarget accepts enabling an s3 target directly', async () => {
    const target = {
      id: 't1',
      siteId: 'site-1',
      module: 's3',
      title: 'S3',
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' }
    } as any
    assert.equal(await storage.validateTarget(target, { id: 't1', isEnabled: true }), null)
  })
})

describe('storage: getFileExtension', () => {
  test('maps markdown to md', () => {
    assert.equal(getFileExtension('markdown'), 'md')
  })

  test('maps asciidoc to adoc', () => {
    assert.equal(getFileExtension('asciidoc'), 'adoc')
  })

  test('maps html to html', () => {
    assert.equal(getFileExtension('html'), 'html')
  })

  test('falls back to txt for a content type with no file representation', () => {
    assert.equal(getFileExtension('redirect'), 'txt')
    assert.equal(getFileExtension('something-unknown'), 'txt')
  })
})

function makeDiskRow(
  siteId: string,
  overrides: { isEnabled?: boolean; createDailyBackups?: boolean } = {}
) {
  return {
    id: `target-disk-${siteId}`,
    siteId,
    module: 'disk',
    isEnabled: overrides.isEnabled ?? true,
    contentTypes: { activeTypes: [], largeThreshold: '5MB' },
    assetDelivery: { streaming: false, directAccess: false },
    versioning: { enabled: false },
    syncMode: storage.getDefinition('disk')!.defaultMode,
    scheduleOverride: null,
    config: { path: '/tmp/whatever', createDailyBackups: overrides.createDailyBackups ?? false },
    state: {}
  }
}

/**
 * Each site's storage rows are matched by call order rather than by inspecting the drizzle
 * `where()` expression, which relies on `runDailyBackups()` querying one site right after another,
 * in the same order `sites` lists them.
 */
function fakeDailyBackupDeps(sites: { id: string }[], rowsPerSite: object[][]) {
  const warnings: { message: string; fields?: Record<string, any> }[] = []
  let call = 0
  global.CARDINAL = {
    ...global.CARDINAL,
    db: {
      select: () => ({
        from: (table: any) => {
          if (table === sitesTable) {
            return Promise.resolve(sites)
          }
          const rows = rowsPerSite[call] ?? []
          call++
          return { where: () => Promise.resolve(rows) }
        }
      })
    },
    logger: {
      ...global.CARDINAL.logger,
      warn: (_scope: string, message: string, fields?: Record<string, any>) =>
        warnings.push({ message, fields })
    }
  } as unknown as CardinalGlobal
  return { warnings }
}

/**
 * Pre-seeding the cache is enough to bypass `ensureModule()`'s real dynamic import, and therefore
 * the real filesystem: it returns whatever already sits in `this.modules[key]` before it ever
 * consults a definition or imports anything.
 */
async function withFakeDiskModule(
  dailyBackup: (target: StorageTarget) => Promise<void>,
  fn: () => Promise<void>
): Promise<void> {
  const original = storage.modules.disk
  storage.modules.disk = { dailyBackup }
  try {
    await fn()
  } finally {
    if (original) {
      storage.modules.disk = original
    } else {
      delete storage.modules.disk
    }
  }
}

test('runDailyBackups skips a disabled disk target even when createDailyBackups is on', async () => {
  fakeDailyBackupDeps(
    [{ id: 'site-1' }],
    [[makeDiskRow('site-1', { isEnabled: false, createDailyBackups: true })]]
  )
  const calls: string[] = []
  await withFakeDiskModule(
    async (target) => {
      calls.push(target.siteId)
    },
    async () => {
      const result = await storage.runDailyBackups()
      assert.deepEqual(result, { ran: 0, failed: 0 })
    }
  )
  assert.deepEqual(calls, [])
})

test('runDailyBackups skips an enabled disk target whose createDailyBackups is off', async () => {
  fakeDailyBackupDeps(
    [{ id: 'site-1' }],
    [[makeDiskRow('site-1', { isEnabled: true, createDailyBackups: false })]]
  )
  const calls: string[] = []
  await withFakeDiskModule(
    async (target) => {
      calls.push(target.siteId)
    },
    async () => {
      const result = await storage.runDailyBackups()
      assert.deepEqual(result, { ran: 0, failed: 0 })
    }
  )
  assert.deepEqual(calls, [])
})

test('runDailyBackups runs dailyBackup for every enabled disk target with createDailyBackups on, across sites', async () => {
  fakeDailyBackupDeps(
    [{ id: 'site-1' }, { id: 'site-2' }],
    [
      [makeDiskRow('site-1', { isEnabled: true, createDailyBackups: true })],
      [makeDiskRow('site-2', { isEnabled: true, createDailyBackups: true })]
    ]
  )
  const calls: string[] = []
  await withFakeDiskModule(
    async (target) => {
      calls.push(target.siteId)
    },
    async () => {
      const result = await storage.runDailyBackups()
      assert.deepEqual(result, { ran: 2, failed: 0 })
    }
  )
  assert.deepEqual(calls.sort(), ['site-1', 'site-2'])
})

test('runDailyBackups skips a module with no dailyBackup handler (e.g. db)', async () => {
  fakeDailyBackupDeps(
    [{ id: 'site-1' }],
    [
      [
        {
          id: 'target-db-site-1',
          siteId: 'site-1',
          module: 'db',
          isEnabled: true,
          contentTypes: { activeTypes: [], largeThreshold: '5MB' },
          assetDelivery: { streaming: false, directAccess: false },
          versioning: { enabled: false },
          syncMode: storage.getDefinition('db')!.defaultMode,
          scheduleOverride: null,
          // -> `db` has no `createDailyBackups` prop at all, but even if a config blob somehow had
          //    one set, the db module declares no `dailyBackup` handler -- nothing to call
          config: { createDailyBackups: true },
          state: {}
        }
      ]
    ]
  )
  const result = await storage.runDailyBackups()
  assert.deepEqual(result, { ran: 0, failed: 0 })
})

/**
 * Backup is a module-owned action declared (or not) per `definition.yml` rather than one generic
 * routine every module is forced through, so there is no shared disk-shaped code path for a git
 * target to break through: `git`'s own definition declares no `createDailyBackups` prop and no
 * `backup`/`dailyBackup` action at all, its commit history plus pushing to `origin` being its
 * backup.
 */
test('runDailyBackups skips a git target — the module declares no dailyBackup handler', async () => {
  fakeDailyBackupDeps(
    [{ id: 'site-1' }],
    [
      [
        {
          id: 'target-git-site-1',
          siteId: 'site-1',
          module: 'git',
          isEnabled: true,
          contentTypes: { activeTypes: ['pages'], largeThreshold: '5MB' },
          assetDelivery: { streaming: false, directAccess: false },
          versioning: { enabled: true },
          syncMode: storage.getDefinition('git')!.defaultMode,
          scheduleOverride: null,
          config: {},
          state: {}
        }
      ]
    ]
  )
  const result = await storage.runDailyBackups()
  assert.deepEqual(result, { ran: 0, failed: 0 })
})

test('the git module definition declares no backup-shaped action or config prop', () => {
  const definition = storage.getDefinition('git')!
  assert.equal(
    definition.actions.some((action) => /backup/i.test(action.handler)),
    false
  )
  assert.equal('createDailyBackups' in definition.props, false)
})

test('runDailyBackups logs and continues past a target whose dailyBackup throws, without failing the others', async () => {
  const { warnings } = fakeDailyBackupDeps(
    [{ id: 'site-1' }, { id: 'site-2' }],
    [
      [makeDiskRow('site-1', { isEnabled: true, createDailyBackups: true })],
      [makeDiskRow('site-2', { isEnabled: true, createDailyBackups: true })]
    ]
  )
  const calls: string[] = []
  await withFakeDiskModule(
    async (target) => {
      calls.push(target.siteId)
      if (target.siteId === 'site-1') {
        throw new Error('disk full')
      }
    },
    async () => {
      const result = await storage.runDailyBackups()
      assert.deepEqual(result, { ran: 1, failed: 1 })
    }
  )
  assert.deepEqual(calls.sort(), ['site-1', 'site-2'])
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]!.fields?.site, 'site-1')
  assert.match(warnings[0]!.fields?.error?.message ?? '', /disk full/)
})
