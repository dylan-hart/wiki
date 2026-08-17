import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { storage, SYNC_SHAPED_ACTIONS } from './storage.ts'
import type { StorageTarget } from './storage.ts'

// -> `refreshFromDisk()` reads real files under `modules/storage`, so the only setup needed is a
//    minimal `WIKI` global pointing at this checkout's `backend/` directory — no database involved.
before(async () => {
  // -> Node 25 (this sandbox) has no native `Temporal` yet — Node 26 does, per this repo's engine
  //    requirement. Polyfilled only when missing, so this is a no-op on a real Node 26 runtime. The
  //    package polyfills the `Temporal` global itself but, unlike Node 26, does not also patch
  //    `Date.prototype.toTemporalInstant()` -- `tickScheduledSyncs()` uses that conversion (this
  //    codebase's documented convention, see CLAUDE.md), so it is patched on here too.
  if (typeof Temporal === 'undefined') {
    const polyfill = await import('@js-temporal/polyfill')
    ;(globalThis as any).Temporal = polyfill.Temporal
    ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
      return polyfill.toTemporalInstant.call(this)
    }
  }
  global.WIKI = {
    SERVERPATH: path.join(import.meta.dirname, '..'),
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {}
    }
  } as unknown as WikiGlobal
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

/** Builds a minimal target for the given module, as `getSiteTargets` would shape one. */
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
      scheduleOverride: null
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

// ---------------------------------------------------------------------------------------------
// validateTarget() -- disk module's deep `validateConfig` hook (see `StorageModule.validateConfig`)
// ---------------------------------------------------------------------------------------------

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
  // -> `makeTarget`'s disk target has no `path` configured at all -- if the deep check ran here, it
  //    would reject. It must not run for a patch that touches neither `config` nor `isEnabled`.
  const target = makeTarget('disk')
  const invalid = await storage.validateTarget(target, {
    id: target.id,
    sync: { mode: undefined }
  })
  assert.equal(invalid, null)
})

// ---------------------------------------------------------------------------------------------
// dispatch()
// ---------------------------------------------------------------------------------------------

/**
 * Builds a raw `storage` table row for one real module (`git`/`disk` on disk in this checkout), as
 * `WIKI.db.select().from(storageTable)` would return it — i.e. what `getSiteTargets` merges with the
 * module's definition to build a `StorageTarget`.
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
 * Points `WIKI.db` at a fake that answers `getSiteTargets`'s `select().from().where()` chain with
 * `rows`, and `WIKI.scheduler.addJob` at a fake that records calls instead of touching a real queue.
 * Neither is used by anything else `dispatch()` calls, so this is the whole surface it needs mocked.
 */
function fakeDispatchDeps(rows: object[]) {
  const jobs: { task: string; payload: Record<string, any> }[] = []
  global.WIKI = {
    ...global.WIKI,
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) })
    },
    scheduler: {
      addJob: async (opts: { task: string; payload: Record<string, any> }) => {
        jobs.push(opts)
        return { id: `job-${jobs.length}` }
      }
    }
  } as unknown as WikiGlobal
  return jobs
}

// ---------------------------------------------------------------------------------------------
// getSiteTargets()
// ---------------------------------------------------------------------------------------------

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
  const jobs = fakeDispatchDeps([makeRow('disk', { activeTypes: ['documents'], syncMode: 'push' })])
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
  const jobs = fakeDispatchDeps([makeRow('disk', { activeTypes: ['images'], syncMode: 'push' })])
  const queued = await storage.dispatch('asset:edit', {
    id: 'a1',
    siteId: 'site-1',
    kind: 'image',
    fileSize: 100
  })
  assert.equal(queued, 1)
  assert.equal(jobs[0].payload.handler, 'assetUploaded')
})

test("dispatch classifies an asset over a target's own largeThreshold as large", async () => {
  fakeDispatchDeps([
    makeRow('disk', { activeTypes: ['large'], largeThreshold: '1KB', syncMode: 'push' })
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
    makeRow('disk', { activeTypes: ['large'], largeThreshold: '1KB', syncMode: 'push' })
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

// ---------------------------------------------------------------------------------------------
// tickScheduledSyncs()
// ---------------------------------------------------------------------------------------------

/** Builds a raw `storage` row with just the columns `tickScheduledSyncs` reads. */
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
 * Points `WIKI.db` at a fake answering `getTargets`'s `select().from().where()` chain with `rows`,
 * and a fake `update().set().where()` that records what it was asked to set instead of touching a
 * real row. `WIKI.scheduler.addJob` records calls and, unless told to fail, succeeds.
 */
function fakeTickDeps(
  rows: object[],
  { addJobSucceeds = true }: { addJobSucceeds?: boolean } = {}
) {
  const jobs: { task: string; payload: Record<string, any> }[] = []
  const updates: { values: Record<string, any> }[] = []
  global.WIKI = {
    ...global.WIKI,
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
  } as unknown as WikiGlobal
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
  // -> git's own module schedule is PT5M, so 2 minutes elapsed would not be due on its own -- but
  //    this target's scheduleOverride is PT1M, which 2 minutes clears
  const { jobs } = fakeTickDeps([
    makeTickRow('git', { syncMode: 'sync', scheduleOverride: 'PT1M', lastTickAt })
  ])
  const queued = await storage.tickScheduledSyncs(now)
  assert.equal(queued, 1)
  assert.equal(jobs.length, 1)
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

test('tickScheduledSyncs logs and skips a target with an unparseable schedule override, without throwing', async () => {
  const { jobs } = fakeTickDeps([
    makeTickRow('git', { syncMode: 'sync', scheduleOverride: 'not-a-duration' })
  ])
  const queued = await storage.tickScheduledSyncs()
  assert.equal(queued, 0)
  assert.equal(jobs.length, 0)
})
