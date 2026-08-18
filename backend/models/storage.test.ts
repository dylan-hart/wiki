import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
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

/**
 * Task 545: confirm end-to-end that the three cloud module `storage.ts` files landed by tasks
 * 540/541/544 are actually wired through `models/storage.ts` — `hasImplementation()` flips true,
 * `getSiteTargets()` exposes their `exportAll` action, and `executeAction()` genuinely dispatches to a
 * module's handler — plus the config-validation edge cases `validateConfig`/`validateTarget` already
 * enforce that a cloud target's props exercise (e.g. s3's mode-gated enums).
 */

const silentLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

describe('storage / validateConfig, validateTarget (pure, real s3 definition read from disk)', () => {
  before(async () => {
    // -> A plain `fs.readdir`/`fs.readFile` under `modules/storage`, no database — the one thing it
    //    needs from `WIKI` is `SERVERPATH` pointed at this checkout's real `backend/` directory.
    ;(globalThis as any).WIKI = {
      SERVERPATH: path.join(import.meta.dirname, '..'),
      logger: silentLogger
    }
    await storage.refreshFromDisk()
  })

  after(() => {
    delete (globalThis as any).WIKI
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
    //    `validateConfig` has no notion of that UI gate — it validates every incoming key against its
    //    own prop declaration, so a bogus `awsRegion` is refused even while `mode` is `do`. This is the
    //    "s3's mode-gated props" edge case task 545 calls out explicitly.
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

  test('validateTarget rejects an unknown content type', () => {
    const definition = storage.getDefinition('s3')!
    const target = {
      id: 't1',
      siteId: 'site-1',
      module: 's3',
      title: definition.title,
      contentTypes: { activeTypes: [], largeThreshold: '5MB' },
      setup: undefined
    } as any
    const invalid = storage.validateTarget(target, {
      id: 't1',
      contentTypes: { activeTypes: ['videos'] }
    })
    assert.match(invalid ?? '', /"videos" is not a valid content type/)
  })

  test('validateTarget rejects a malformed largeThreshold', () => {
    const target = {
      id: 't1',
      siteId: 'site-1',
      module: 's3',
      title: 'S3',
      contentTypes: { activeTypes: [], largeThreshold: '5MB' },
      setup: undefined
    } as any
    const invalid = storage.validateTarget(target, {
      id: 't1',
      contentTypes: { largeThreshold: 'huge' }
    })
    assert.match(invalid ?? '', /"huge" is not a valid size threshold/)
  })

  test('validateTarget accepts enabling an s3 target directly — it declares no setup process to gate on', () => {
    const target = {
      id: 't1',
      siteId: 'site-1',
      module: 's3',
      title: 'S3',
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' },
      setup: undefined
    } as any
    assert.equal(storage.validateTarget(target, { id: 't1', isEnabled: true }), null)
  })
})

describe(
  'storage / hasImplementation, getSiteTargets, executeAction wiring (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
      // -> `test/db.ts` computes `SERVERPATH` as `path.join(process.cwd(), 'backend')`, which is
      //    correct when the process is launched from the repo root but not from `backend/` itself —
      //    this repo's convention (CLAUDE.md: "Run backend commands from backend/") is the latter.
      //    Repointed here rather than in the shared fixture, which is owned by a different feature.
      WIKI.SERVERPATH = path.join(import.meta.dirname, '..')
      await storage.refreshFromDisk()
      await storage.syncSite(fixtures.siteId)
    })

    after(async () => {
      await teardownTestDb()
    })

    test('hasImplementation() flips true for s3, azure and gcs, and stays false for a config-only module', () => {
      assert.equal(storage.getDefinition('s3')?.hasImplementation, true)
      assert.equal(storage.getDefinition('azure')?.hasImplementation, true)
      assert.equal(storage.getDefinition('gcs')?.hasImplementation, true)
      // -> sftp ships only a definition.yml, no storage.ts — the contrast case proving the flip is a
      //    real disk check and not a constant true.
      assert.equal(storage.getDefinition('sftp')?.hasImplementation, false)
    })

    test('getSiteTargets() exposes the exportAll action for s3/azure/gcs, and none for sftp', async () => {
      const targets = await storage.getSiteTargets(fixtures.siteId)
      for (const key of ['s3', 'azure', 'gcs']) {
        const target = targets.find((t) => t.module === key)
        assert.ok(target, `expected a ${key} target row`)
        assert.ok(
          target!.actions.some((a) => a.handler === 'exportAll'),
          `expected ${key}'s actions to include exportAll`
        )
      }
      const sftpTarget = targets.find((t) => t.module === 'sftp')
      assert.ok(sftpTarget, 'expected an sftp target row')
      assert.deepEqual(sftpTarget!.actions, [])
    })

    test('ensureModule() dynamically loads the real s3 module through the extension-sensitive import path', async () => {
      const mod = await storage.ensureModule('s3')
      assert.ok(mod, 'expected the s3 module to load')
      assert.equal(typeof mod!.exportAll, 'function')
      assert.equal(typeof mod!.assetUploaded, 'function')
      assert.equal(typeof mod!.assetDeleted, 'function')
      assert.equal(typeof mod!.assetRenamed, 'function')
    })

    test('executeAction() dispatches to the module handler with the target it was given', async () => {
      const targets = await storage.getSiteTargets(fixtures.siteId)
      const s3Target = targets.find((t) => t.module === 's3')!

      let calledWith: any
      // -> Swap the cached implementation for a spy: `executeAction` is what's under test here, not
      //    the s3 SDK itself (covered separately by `modules/storage/s3/storage.emulated.test.ts`
      //    against a real S3-compatible server).
      storage.modules.s3 = {
        exportAll: async (target: any) => {
          calledWith = target
        }
      }

      await storage.executeAction(s3Target, 'exportAll')

      assert.equal(calledWith.id, s3Target.id)
      assert.equal(calledWith.module, 's3')
      assert.equal(calledWith.siteId, fixtures.siteId)
    })

    test('executeAction() rejects a handler the module does not implement, with a readable message', async () => {
      const targets = await storage.getSiteTargets(fixtures.siteId)
      const s3Target = targets.find((t) => t.module === 's3')!
      storage.modules.s3 = {}

      await assert.rejects(
        () => storage.executeAction(s3Target, 'exportAll'),
        /does not implement "exportAll"/
      )
    })
  }
)
