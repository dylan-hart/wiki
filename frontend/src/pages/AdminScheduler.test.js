import { describe, expect, it } from 'vitest'

import AdminScheduler from './AdminScheduler.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2337: the Completed/Failed history tabs collapse a task that ran many times (the
 * motivating case is `storageSyncTick`'s every-minute cron tick) into one summary row instead of one
 * row per execution -- see `helpers/jobHistoryGrouping.js` for the pure grouping logic this wires in.
 */
function mountPage() {
  return mountWithApp(AdminScheduler, {
    messages: {
      'admin.scheduler.title': 'Scheduler',
      'admin.scheduler.groupRuns': '1 run | {count} runs',
      'admin.scheduler.groupExpand': 'Show individual runs of {task}',
      'admin.scheduler.groupCollapse': 'Hide individual runs of {task}'
    }
  }).wrapper
}

async function flush(wrapper) {
  await wrapper.vm.$nextTick()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

describe('AdminScheduler empty state (OpenProject #2061)', () => {
  it("renders the Upcoming table's #no-data slot message when there are no upcoming jobs", async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'scheduler/upcoming') {
        return { json: () => Promise.resolve([]) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const wrapper = mountWithApp(AdminScheduler, {
      messages: {
        'admin.scheduler.title': 'Scheduler',
        'admin.scheduler.upcomingNone': 'No upcoming jobs scheduled.'
      }
    }).wrapper
    await flush(wrapper)

    expect(wrapper.vm.state.upcomingJobs).toHaveLength(0)
    expect(wrapper.text()).toContain('No upcoming jobs scheduled.')
  })

  it("renders the Scheduled table's #no-data slot message when there are no cron entries", async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'scheduler/schedule') {
        return { json: () => Promise.resolve([]) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const wrapper = mountWithApp(AdminScheduler, {
      messages: {
        'admin.scheduler.title': 'Scheduler',
        'admin.scheduler.scheduledNone': 'No scheduled tasks.'
      }
    }).wrapper
    await flush(wrapper)

    wrapper.vm.state.displayMode = 'scheduled'
    await flush(wrapper)

    expect(wrapper.vm.state.scheduledJobs).toHaveLength(0)
    expect(wrapper.text()).toContain('No scheduled tasks.')
  })

  it("renders the history tabs' #no-data slot message, keyed by displayMode, when there are no jobs", async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'scheduler/jobs') {
        return { json: () => Promise.resolve({ total: 0, jobs: [] }) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const wrapper = mountWithApp(AdminScheduler, {
      messages: {
        'admin.scheduler.title': 'Scheduler',
        'admin.scheduler.completedNone': 'No completed jobs.'
      }
    }).wrapper
    await flush(wrapper)

    wrapper.vm.state.displayMode = 'completed'
    await flush(wrapper)

    expect(wrapper.vm.historyRows).toHaveLength(0)
    expect(wrapper.text()).toContain('No completed jobs.')
  })
})

describe('AdminScheduler history grouping', () => {
  it('collapses a repeated task into one summary row, and expands it back out on click', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'scheduler/jobs') {
        return {
          json: () =>
            Promise.resolve({
              total: 3,
              jobs: [
                {
                  id: 'tick-3',
                  task: 'storageSyncTick',
                  state: 'completed',
                  startedAt: '2026-08-31T00:03:00.000Z',
                  completedAt: '2026-08-31T00:03:01.000Z',
                  attempt: 1,
                  maxRetries: 0,
                  useWorker: false,
                  executedBy: 'instance-1'
                },
                {
                  id: 'tick-2',
                  task: 'storageSyncTick',
                  state: 'completed',
                  startedAt: '2026-08-31T00:02:00.000Z',
                  completedAt: '2026-08-31T00:02:01.000Z',
                  attempt: 1,
                  maxRetries: 0,
                  useWorker: false,
                  executedBy: 'instance-1'
                },
                {
                  id: 'backup-1',
                  task: 'storageDailyBackup',
                  state: 'completed',
                  startedAt: '2026-08-31T00:01:00.000Z',
                  completedAt: '2026-08-31T00:01:05.000Z',
                  attempt: 1,
                  maxRetries: 0,
                  useWorker: false,
                  executedBy: 'instance-1'
                }
              ]
            })
        }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const wrapper = mountPage()
    await flush(wrapper)

    wrapper.vm.state.displayMode = 'completed'
    await flush(wrapper)

    // -> 2 rows, not 3: the two storageSyncTick entries collapse into one summary row
    expect(wrapper.vm.historyRows).toHaveLength(2)
    expect(wrapper.vm.historyRows[0]).toMatchObject({
      id: 'group:storageSyncTick',
      groupCount: 2,
      groupExpanded: false
    })
    expect(wrapper.vm.historyRows[1]).toMatchObject({ id: 'backup-1', groupCount: 1 })

    wrapper.vm.toggleGroup('storageSyncTick')
    await flush(wrapper)

    // -> Expanded: the summary row stays, plus both individual runs underneath it
    expect(wrapper.vm.historyRows).toHaveLength(4)
    expect(wrapper.vm.historyRows.map((r) => r.id)).toEqual([
      'group:storageSyncTick',
      'tick-3',
      'tick-2',
      'backup-1'
    ])
    expect(wrapper.vm.historyRows[0].groupExpanded).toBe(true)
  })
})

/**
 * OpenProject #2589: the "Retry Job" button's disable rule was, until now, guarded only by
 * `e2e/tests/scheduler.spec.js`'s two Failed-tab cases -- which run against a real backend whose
 * `storageSyncTick` cron is depositing rows throughout, and which have been reported red without
 * anyone being able to reproduce them. Pinning the rule here makes the two answerable apart: a red
 * e2e run against a green suite here is timing, a red run here is a real regression.
 *
 * The rule itself (`AdminScheduler.vue`'s `body-cell-actions` template): the button is withheld
 * entirely from an `active` row (nothing to retry yet) and from a collapsed group's summary row
 * (its `id` is `group:<task>`, not a real job id), and it is rendered-but-disabled while the
 * scheduler still owes the job an automatic attempt -- which `reapStaleJobs` decides by
 * `attempt <= maxRetries` for `interrupted` exactly as `runJob` does for `failed`, so both states
 * are withheld the same way.
 */
function historyJob(overrides) {
  return {
    id: 'job-1',
    task: 'someTask',
    state: 'failed',
    attempt: 1,
    maxRetries: 2,
    useWorker: false,
    executedBy: 'instance-1',
    startedAt: '2026-08-31T00:01:00.000Z',
    completedAt: null,
    lastErrorMessage: 'Synthetic failure',
    ...overrides
  }
}

/** Mounts the page with `jobs` already loaded into the Failed tab, and returns its rendered rows. */
async function mountFailedTab(jobs) {
  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'scheduler/jobs') {
      return { json: () => Promise.resolve({ total: jobs.length, jobs }) }
    }
    return { json: () => Promise.resolve(undefined) }
  })

  const wrapper = mountWithApp(AdminScheduler, {
    messages: {
      'admin.scheduler.title': 'Scheduler',
      'admin.scheduler.retryJob': 'Retry Job',
      'admin.scheduler.error': 'Error',
      'admin.scheduler.interrupted': 'Interrupted',
      'admin.scheduler.pending': 'Pending',
      'admin.scheduler.groupRuns': '1 run | {count} runs',
      'admin.scheduler.groupExpand': 'Show individual runs of {task}',
      'admin.scheduler.groupCollapse': 'Hide individual runs of {task}'
    }
  }).wrapper
  await flush(wrapper)

  wrapper.vm.state.displayMode = 'failed'
  await flush(wrapper)

  return { wrapper, rows: wrapper.findAll('table tbody tr') }
}

/** `null` when the row renders no retry button at all, otherwise whether it renders disabled. */
function retryButtonDisabled(row) {
  const btn = row.find('button[aria-label="Retry Job"]')
  return btn.exists() ? btn.attributes('disabled') !== undefined : null
}

describe('AdminScheduler Retry Job availability (OpenProject #2589)', () => {
  it.each([
    // -> `attempt` counts from 1 and `maxRetries` is how many EXTRA attempts the job gets, so
    //    `attempt <= maxRetries` is "the scheduler is still going to try this again on its own".
    { state: 'failed', attempt: 1, maxRetries: 2, expected: true },
    { state: 'interrupted', attempt: 1, maxRetries: 2, expected: true },
    // -> The boundary: the last automatic attempt is still owed at `attempt === maxRetries`, and
    //    the button only comes live once `attempt` has passed it.
    { state: 'failed', attempt: 2, maxRetries: 2, expected: true },
    { state: 'interrupted', attempt: 2, maxRetries: 2, expected: true },
    { state: 'failed', attempt: 3, maxRetries: 2, expected: false },
    { state: 'interrupted', attempt: 3, maxRetries: 2, expected: false },
    // -> Nothing is owed when no retries were budgeted at all.
    { state: 'failed', attempt: 1, maxRetries: 0, expected: false },
    { state: 'interrupted', attempt: 1, maxRetries: 0, expected: false }
  ])(
    'a $state job at attempt $attempt/$maxRetries renders Retry Job disabled=$expected',
    async ({ state, attempt, maxRetries, expected }) => {
      const { rows } = await mountFailedTab([historyJob({ state, attempt, maxRetries })])

      expect(rows).toHaveLength(1)
      expect(retryButtonDisabled(rows[0])).toBe(expected)
    }
  )

  it('renders no Retry Job button at all on an active row', async () => {
    const { rows } = await mountFailedTab([
      historyJob({ state: 'active', attempt: 1, maxRetries: 2, lastErrorMessage: null })
    ])

    expect(rows).toHaveLength(1)
    expect(retryButtonDisabled(rows[0])).toBeNull()
  })

  it("renders no Retry Job button on a collapsed group's summary row, only on its expanded children", async () => {
    // -> Same task name twice, so #2337's grouping collapses them into one summary row whose `id`
    //    is `group:<task>` -- there is no real job behind it to retry.
    const jobs = [
      historyJob({ id: 'interrupted-2', task: 'repeatedTask', state: 'interrupted', attempt: 3 }),
      historyJob({ id: 'interrupted-1', task: 'repeatedTask', state: 'interrupted', attempt: 3 })
    ]
    const { wrapper, rows } = await mountFailedTab(jobs)

    expect(rows).toHaveLength(1)
    expect(wrapper.vm.historyRows[0].id).toBe('group:repeatedTask')
    expect(retryButtonDisabled(rows[0])).toBeNull()

    wrapper.vm.toggleGroup('repeatedTask')
    await flush(wrapper)

    // -> Expanded: the summary row still withholds it, while each child row -- a real,
    //    individually-actionable entry, exhausted at 3/2 -- offers it live.
    const expandedRows = wrapper.findAll('table tbody tr')
    expect(expandedRows).toHaveLength(3)
    expect(expandedRows.map((row) => retryButtonDisabled(row))).toEqual([null, false, false])
  })
})
