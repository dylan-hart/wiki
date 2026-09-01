import { describe, expect, it } from 'vitest'

import { flattenJobHistoryRows, groupJobHistory } from './jobHistoryGrouping.js'

function job(overrides) {
  return {
    id: 'id-default',
    task: 'storageSyncTick',
    state: 'completed',
    startedAt: '2026-08-31T00:00:00.000Z',
    completedAt: '2026-08-31T00:00:01.000Z',
    ...overrides
  }
}

describe('groupJobHistory()', () => {
  it('returns an empty list for no jobs', () => {
    expect(groupJobHistory([])).toEqual([])
    expect(groupJobHistory(undefined)).toEqual([])
  })

  it('keeps a single-entry task as its own group of one', () => {
    const j = job({ id: 'a', task: 'cleanJobHistory' })
    const groups = groupJobHistory([j])
    expect(groups).toEqual([{ task: 'cleanJobHistory', entries: [j], count: 1 }])
  })

  it('groups every entry sharing a task name, even when not contiguous', () => {
    const tick1 = job({ id: 'tick-1', task: 'storageSyncTick' })
    const other = job({ id: 'other-1', task: 'cleanJobHistory' })
    const tick2 = job({ id: 'tick-2', task: 'storageSyncTick' })

    const groups = groupJobHistory([tick1, other, tick2])

    expect(groups).toEqual([
      { task: 'storageSyncTick', entries: [tick1, tick2], count: 2 },
      { task: 'cleanJobHistory', entries: [other], count: 1 }
    ])
  })

  it('orders groups by each group’s most recent (first-seen) entry, not alphabetically', () => {
    const zTask = job({ id: 'z-1', task: 'zzzLastAlphabetically' })
    const aTask = job({ id: 'a-1', task: 'aaaFirstAlphabetically' })

    const groups = groupJobHistory([zTask, aTask])

    expect(groups.map((g) => g.task)).toEqual(['zzzLastAlphabetically', 'aaaFirstAlphabetically'])
  })

  it('preserves each entry’s original relative (newest-first) order within its group', () => {
    const newest = job({ id: 'newest', startedAt: '2026-08-31T00:03:00.000Z' })
    const middle = job({ id: 'middle', startedAt: '2026-08-31T00:02:00.000Z' })
    const oldest = job({ id: 'oldest', startedAt: '2026-08-31T00:01:00.000Z' })

    const [group] = groupJobHistory([newest, middle, oldest])

    expect(group.entries.map((e) => e.id)).toEqual(['newest', 'middle', 'oldest'])
  })
})

describe('flattenJobHistoryRows()', () => {
  it('returns an empty list for no jobs', () => {
    expect(flattenJobHistoryRows([], new Set())).toEqual([])
  })

  it('renders a single-entry task as an ordinary, ungrouped row', () => {
    const j = job({ id: 'solo', task: 'cleanJobHistory' })
    const rows = flattenJobHistoryRows([j], new Set())
    expect(rows).toEqual([{ ...j, groupCount: 1 }])
  })

  it('collapses a multi-entry task into one synthetic summary row when not expanded', () => {
    const tick1 = job({ id: 'tick-1', state: 'completed' })
    const tick2 = job({ id: 'tick-2', state: 'failed' })

    const rows = flattenJobHistoryRows([tick1, tick2], new Set())

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'group:storageSyncTick',
      task: 'storageSyncTick',
      // -> The summary row reflects the MOST RECENT entry's own state, not some rollup
      state: 'completed',
      groupCount: 2,
      groupTask: 'storageSyncTick',
      groupExpanded: false
    })
  })

  it('expands into the summary row plus every individual entry when the task is in expandedTasks', () => {
    const tick1 = job({ id: 'tick-1' })
    const tick2 = job({ id: 'tick-2' })

    const rows = flattenJobHistoryRows([tick1, tick2], new Set(['storageSyncTick']))

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      id: 'group:storageSyncTick',
      groupCount: 2,
      groupExpanded: true
    })
    expect(rows[1]).toEqual({ ...tick1, groupCount: 1, groupChild: true })
    expect(rows[2]).toEqual({ ...tick2, groupCount: 1, groupChild: true })
  })

  it('never lets the synthetic summary row’s id collide with a real entry’s id', () => {
    const tick1 = job({
      id: 'group:storageSyncTick' /* pathological but not impossible upstream id */
    })
    const tick2 = job({ id: 'tick-2' })

    const rows = flattenJobHistoryRows([tick1, tick2], new Set())

    // -> The summary row always wins the `group:<task>` id -- a real entry that happened to already
    //    have exactly that id only ever shows up (unambiguously) once the group is expanded.
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('group:storageSyncTick')
  })

  it('treats an undefined expandedTasks the same as an empty one', () => {
    const tick1 = job({ id: 'tick-1' })
    const tick2 = job({ id: 'tick-2' })

    const rows = flattenJobHistoryRows([tick1, tick2], undefined)

    expect(rows).toHaveLength(1)
    expect(rows[0].groupExpanded).toBe(false)
  })

  it('groups tasks independently -- one expanded, one collapsed, one ungrouped', () => {
    const tick1 = job({ id: 'tick-1', task: 'storageSyncTick' })
    const tick2 = job({ id: 'tick-2', task: 'storageSyncTick' })
    const backup1 = job({ id: 'backup-1', task: 'storageDailyBackup' })
    const backup2 = job({ id: 'backup-2', task: 'storageDailyBackup' })
    const solo = job({ id: 'solo-1', task: 'cleanJobHistory' })

    const rows = flattenJobHistoryRows(
      [tick1, tick2, backup1, backup2, solo],
      new Set(['storageSyncTick'])
    )

    expect(rows.map((r) => [r.id, r.groupChild ?? false])).toEqual([
      ['group:storageSyncTick', false],
      ['tick-1', true],
      ['tick-2', true],
      ['group:storageDailyBackup', false],
      ['solo-1', false]
    ])
  })
})
