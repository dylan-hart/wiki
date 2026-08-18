import { describe, expect, it } from 'vitest'
import { isQueuedAction, syncPayloadFor, syncStatusKind } from './storageSync.js'

describe('isQueuedAction', () => {
  it('is true for a sync-shaped action handler', () => {
    expect(isQueuedAction('sync')).toBe(true)
    expect(isQueuedAction('syncUntracked')).toBe(true)
    expect(isQueuedAction('importAll')).toBe(true)
  })

  it('is false for a synchronous action handler', () => {
    expect(isQueuedAction('purge')).toBe(false)
    expect(isQueuedAction('dump')).toBe(false)
  })
})

describe('syncPayloadFor', () => {
  it('is undefined for a target with no sync group at all', () => {
    expect(syncPayloadFor({})).toBeUndefined()
  })

  it('is undefined for a single-mode, unscheduled module (e.g. disk, s3)', () => {
    const target = {
      sync: { supportedModes: ['push'], schedule: false, mode: 'push', scheduleOverride: null }
    }
    expect(syncPayloadFor(target)).toBeUndefined()
  })

  it('omits mode but includes scheduleOverride for a single-mode module that IS scheduled', () => {
    // -> Sending `mode` here would make the whole batched PUT fail: validateTarget refuses a mode
    //    patch outright when the module offers no choice, regardless of the value sent.
    const target = {
      sync: { supportedModes: ['pull'], schedule: 'PT5M', mode: 'pull', scheduleOverride: 'PT10M' }
    }
    expect(syncPayloadFor(target)).toEqual({ scheduleOverride: 'PT10M' })
  })

  it('includes both mode and scheduleOverride for a multi-mode scheduled module (e.g. git)', () => {
    const target = {
      sync: {
        supportedModes: ['sync', 'push', 'pull'],
        schedule: 'PT5M',
        mode: 'push',
        scheduleOverride: null
      }
    }
    expect(syncPayloadFor(target)).toEqual({ mode: 'push', scheduleOverride: null })
  })

  it('sends scheduleOverride: null rather than omitting it when no override is set', () => {
    const target = {
      sync: {
        supportedModes: ['sync', 'push', 'pull'],
        schedule: 'PT5M',
        mode: 'sync',
        scheduleOverride: null
      }
    }
    expect(syncPayloadFor(target).scheduleOverride).toBe(null)
  })

  it('normalizes a cleared (empty string) override to null rather than sending an invalid duration', () => {
    const target = {
      sync: {
        supportedModes: ['sync', 'push', 'pull'],
        schedule: 'PT5M',
        mode: 'sync',
        scheduleOverride: ''
      }
    }
    expect(syncPayloadFor(target).scheduleOverride).toBe(null)
  })
})

describe('syncStatusKind', () => {
  it('is "never" when nothing has ever synced and there is no error', () => {
    expect(syncStatusKind({ lastSyncedAt: null, lastError: null, outOfDateCount: 0 })).toBe('never')
  })

  it('is "synced" when the last sync succeeded and nothing is stale', () => {
    expect(
      syncStatusKind({ lastSyncedAt: '2026-08-16T00:00:00Z', lastError: null, outOfDateCount: 0 })
    ).toBe('synced')
  })

  it('is "outOfDate" once something has synced before but content has since drifted', () => {
    expect(
      syncStatusKind({ lastSyncedAt: '2026-08-16T00:00:00Z', lastError: null, outOfDateCount: 3 })
    ).toBe('outOfDate')
  })

  it('is "error" even when a prior sync succeeded, since the most recent attempt failed', () => {
    expect(
      syncStatusKind({
        lastSyncedAt: '2026-08-16T00:00:00Z',
        lastError: 'connection refused',
        outOfDateCount: 0
      })
    ).toBe('error')
  })

  it('defaults to "never" when called with nothing at all', () => {
    expect(syncStatusKind()).toBe('never')
  })

  it('defaults to "never" for null, not just undefined -- what state.syncStatus starts as', () => {
    expect(syncStatusKind(null)).toBe('never')
  })
})
