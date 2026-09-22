import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import TasksRollup from './TasksRollup.vue'
import { notify } from '@/composables/notify'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

vi.mock('@/composables/notify', () => ({ notify: vi.fn() }))

const MESSAGES = {
  tasks: {
    title: 'Open Tasks',
    empty: 'No open tasks anywhere.',
    emptyFiltered: 'No open tasks match.',
    summary: '{items} open task(s) on {pages} page(s)',
    clearFilters: 'Clear filters',
    folder: 'Folder'
  },
  search: { loadMore: 'Load More' }
}

const FIXTURE_TAGS = [
  { tag: 'ops', usageCount: 2 },
  { tag: 'safety', usageCount: 1 }
]

const PAGE_A = {
  pageId: 'a1',
  path: 'ops/checklist',
  locale: 'en',
  title: 'Ops Checklist',
  tags: ['ops'],
  updatedAt: '2026-09-01T00:00:00.000Z',
  items: [
    { index: 0, text: 'Check the boiler', line: 2 },
    { index: 2, text: 'Order filters', line: 5 }
  ]
}

const PAGE_B = {
  pageId: 'b2',
  path: 'safety/drills',
  locale: 'en',
  title: 'Safety Drills',
  tags: ['safety'],
  updatedAt: '2026-09-02T00:00:00.000Z',
  items: [{ index: 1, text: 'Run the fire drill', line: 4 }]
}

function rollup(results, totalHits = results.length, totalItems) {
  return {
    results,
    totalHits,
    totalItems: totalItems ?? results.reduce((n, r) => n + r.items.length, 0)
  }
}

async function mountRollup(initialPath = '/_tasks', response = rollup([PAGE_A, PAGE_B])) {
  API_CLIENT.get.mockImplementation((url) => ({
    json: () => Promise.resolve(url.endsWith('/tags') ? FIXTURE_TAGS : response)
  }))
  const router = await createTestRouter(
    [{ path: '/_tasks', component: TasksRollup }, '/:pathMatch(.*)*'],
    initialPath
  )
  const mounted = mountWithApp(TasksRollup, {
    messages: MESSAGES,
    router,
    stores: { site: { id: 'site-1' } }
  })
  await flushPromises()
  return { ...mounted, router }
}

function tasksCalls() {
  return API_CLIENT.get.mock.calls.filter(([url]) => url === 'sites/site-1/tasks')
}

describe('TasksRollup.vue', () => {
  it('fetches the roll-up for the current site on mount', async () => {
    await mountRollup()

    expect(tasksCalls()).toHaveLength(1)
    expect(tasksCalls()[0][1].searchParams).toMatchObject({ offset: 0 })
    expect(tasksCalls()[0][1].searchParams).not.toHaveProperty('tag')
    expect(tasksCalls()[0][1].searchParams).not.toHaveProperty('folder')
  })

  it('groups the items under one row per page', async () => {
    const { wrapper } = await mountRollup()

    const groups = wrapper.findAll('.tasks-rollup-group')
    expect(groups).toHaveLength(2)
    expect(groups[0].attributes('data-page-id')).toBe('a1')
    expect(groups[0].findAll('li').map((li) => li.text())).toEqual([
      'Check the boiler',
      'Order filters'
    ])
    expect(groups[1].findAll('li').map((li) => li.text())).toEqual(['Run the fire drill'])
  })

  it('links each group to its page', async () => {
    const { wrapper } = await mountRollup()

    const links = wrapper.findAll('a.tasks-rollup-page-link')
    expect(links.map((a) => a.text())).toEqual(['Ops Checklist', 'Safety Drills'])
    expect(links.map((a) => a.attributes('href'))).toEqual(['/ops/checklist', '/safety/drills'])
  })

  it('renders item text as plain text, never as markup', async () => {
    const page = { ...PAGE_A, items: [{ index: 0, text: '<b>bold</b> task', line: 0 }] }
    const { wrapper } = await mountRollup('/_tasks', rollup([page]))

    expect(wrapper.find('.tasks-rollup-item-text').text()).toBe('<b>bold</b> task')
    expect(wrapper.find('.tasks-rollup-item-text b').exists()).toBe(false)
  })

  it('shows the totals in the summary', async () => {
    const { wrapper } = await mountRollup()

    expect(wrapper.find('.tasks-rollup-summary').text()).toBe('3 open task(s) on 2 page(s)')
  })

  it('shows the empty state when nothing is open', async () => {
    const { wrapper } = await mountRollup('/_tasks', rollup([]))

    expect(wrapper.find('.tasks-rollup-empty').text()).toBe('No open tasks anywhere.')
    expect(wrapper.findAll('.tasks-rollup-group')).toHaveLength(0)
  })

  it('shows a filter-specific empty state when a filter is active', async () => {
    const { wrapper } = await mountRollup('/_tasks?tag=ops', rollup([]))

    expect(wrapper.find('.tasks-rollup-empty').text()).toBe('No open tasks match.')
  })

  it('hydrates the tag and folder filters from the route query', async () => {
    const { wrapper } = await mountRollup('/_tasks?tag=ops,safety&folder=ops')

    expect(tasksCalls()[0][1].searchParams).toMatchObject({
      tag: 'ops,safety',
      folder: 'ops',
      offset: 0
    })
    const selected = wrapper
      .findAll('.tasks-rollup-chips .w-chip')
      .filter((chip) => chip.attributes('data-selected') === 'true')
    expect(selected).toHaveLength(2)
  })

  it('pushes the tag into the route and refetches when a tag chip is clicked', async () => {
    const { wrapper, router } = await mountRollup()

    await wrapper.findAll('.tasks-rollup-chips .w-chip')[0].trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.tag).toBe('ops')
    expect(tasksCalls()).toHaveLength(2)
    expect(tasksCalls()[1][1].searchParams).toMatchObject({ tag: 'ops' })
  })

  it('clears every filter', async () => {
    const { wrapper, router } = await mountRollup('/_tasks?tag=ops&folder=ops')

    const clear = wrapper.findAll('button').find((b) => b.text() === 'Clear filters')
    await clear.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query).toEqual({})
    expect(tasksCalls()).toHaveLength(2)
    expect(tasksCalls()[1][1].searchParams).not.toHaveProperty('tag')
  })

  it('appends the next page of results on Load More', async () => {
    const { wrapper } = await mountRollup('/_tasks', rollup([PAGE_A], 2, 3))
    API_CLIENT.get.mockImplementation(() => ({
      json: () => Promise.resolve(rollup([PAGE_B], 2, 3))
    }))

    const more = wrapper.findAll('button').find((b) => b.text() === 'Load More')
    await more.trigger('click')
    await flushPromises()

    expect(tasksCalls()[1][1].searchParams).toMatchObject({ offset: 1 })
    expect(wrapper.findAll('.tasks-rollup-group')).toHaveLength(2)
    expect(wrapper.findAll('button').find((b) => b.text() === 'Load More')).toBeUndefined()
  })

  it('notifies and shows the empty state when the request fails', async () => {
    API_CLIENT.get.mockImplementation((url) => ({
      json: () => (url.endsWith('/tags') ? Promise.resolve([]) : Promise.reject(new Error('boom')))
    }))
    const router = await createTestRouter(
      [{ path: '/_tasks', component: TasksRollup }, '/:pathMatch(.*)*'],
      '/_tasks'
    )
    const { wrapper } = mountWithApp(TasksRollup, {
      messages: MESSAGES,
      router,
      stores: { site: { id: 'site-1' } }
    })
    await flushPromises()

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative' }))
    expect(wrapper.find('.tasks-rollup-empty').exists()).toBe(true)
  })
})
