import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { storage } from './storage.ts'
import type { StorageTarget } from './storage.ts'

// -> `refreshFromDisk()` reads real files under `modules/storage`, so the only setup needed is a
//    minimal `WIKI` global pointing at this checkout's `backend/` directory — no database involved.
before(async () => {
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

/** Builds a minimal target for the given module, as `getSiteTargets` would shape one. */
function makeTarget(moduleKey: string): StorageTarget {
  const definition = storage.getDefinition(moduleKey)!
  return {
    id: '00000000-0000-0000-0000-000000000000',
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

test("validateTarget rejects a sync mode outside the module's supportedModes", () => {
  const target = makeTarget('git')
  const invalid = storage.validateTarget(target, { id: target.id, sync: { mode: 'teleport' } })
  assert.match(invalid ?? '', /not a valid sync mode/)
})

test('validateTarget accepts a sync mode change for a multi-mode module', () => {
  const target = makeTarget('git')
  const invalid = storage.validateTarget(target, { id: target.id, sync: { mode: 'push' } })
  assert.equal(invalid, null)
})

test('validateTarget rejects a sync mode change for a single-mode module', () => {
  const target = makeTarget('disk')
  const invalid = storage.validateTarget(target, { id: target.id, sync: { mode: 'push' } })
  assert.match(invalid ?? '', /does not support changing/)
})

test('validateTarget rejects a malformed scheduleOverride', () => {
  const target = makeTarget('git')
  const invalid = storage.validateTarget(target, {
    id: target.id,
    sync: { scheduleOverride: 'not-a-duration' }
  })
  assert.match(invalid ?? '', /not a valid ISO-8601 duration/)
})

test('validateTarget rejects a scheduleOverride on an event-only module', () => {
  const target = makeTarget('disk')
  const invalid = storage.validateTarget(target, {
    id: target.id,
    sync: { scheduleOverride: 'PT10M' }
  })
  assert.match(invalid ?? '', /does not sync on a schedule/)
})

test('validateTarget accepts a valid scheduleOverride on a scheduled module', () => {
  const target = makeTarget('git')
  const invalid = storage.validateTarget(target, {
    id: target.id,
    sync: { scheduleOverride: 'PT10M' }
  })
  assert.equal(invalid, null)
})

test('validateTarget accepts clearing a scheduleOverride', () => {
  const target = makeTarget('git')
  target.sync.scheduleOverride = 'PT10M'
  const invalid = storage.validateTarget(target, {
    id: target.id,
    sync: { scheduleOverride: null }
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
