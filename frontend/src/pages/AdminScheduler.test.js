import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminScheduler from './AdminScheduler.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * OpenProject #1929: `/admin/scheduler` names a job-scheduler concept this fork invented (no upstream
 * Wiki.js docs site can describe it), so the `docsBase`-based help button was deleted rather than left
 * pointing at a page that does not exist. Reads the raw source rather than mounting the component --
 * `AdminScheduler.vue` polls the scheduler API and pulls in several composables, and a full mount is
 * out of proportion for asserting that some markup is simply gone -- so this also guards against the
 * button quietly being reintroduced.
 */
const source = readFileSync(join(import.meta.dirname, 'AdminScheduler.vue'), 'utf-8')

describe('AdminScheduler help link', () => {
  it('has no docsBase-based help/docs button', () => {
    expect(source).not.toContain('docsBase')
  })
})

/**
 * OpenProject #2337: the Completed/Failed history tabs collapse a task that ran many times (the
 * motivating case is `storageSyncTick`'s every-minute cron tick) into one summary row instead of one
 * row per execution -- see `helpers/jobHistoryGrouping.js` for the pure grouping logic this wires in.
 */
function mountPage() {
  setActivePinia(createPinia())

  const i18n = createTestI18n({
    'admin.scheduler.title': 'Scheduler',
    'admin.scheduler.groupRuns': '1 run | {count} runs',
    'admin.scheduler.groupExpand': 'Show individual runs of {task}',
    'admin.scheduler.groupCollapse': 'Hide individual runs of {task}'
  })

  return mount(AdminScheduler, {
    global: {
      plugins: [i18n]
    }
  })
}

async function flush(wrapper) {
  await wrapper.vm.$nextTick()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

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
