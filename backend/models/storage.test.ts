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
