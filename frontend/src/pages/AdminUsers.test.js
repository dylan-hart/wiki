import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminUsers from './AdminUsers.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

const USERS_PAGE_1 = {
  total: 45,
  users: [{ id: 1, name: 'Alice', email: 'alice@example.com', isSystem: false }]
}

function usersResponse({ total = 45, users = USERS_PAGE_1.users } = {}) {
  return { json: () => Promise.resolve({ total, users }) }
}

const MESSAGES = {
  'admin.users.emptyText': 'No users have been created yet.',
  'admin.users.searchNoResults': 'No user matches your search.'
}

async function mountPage() {
  API_CLIENT.get.mockImplementation(() => usersResponse())

  const router = await createTestRouter(['/_admin/users'], '/_admin/users')

  const { wrapper } = mountWithApp(AdminUsers, {
    messages: MESSAGES,
    router,
    stores: { user: { permissions: ['manage:users'], id: 'me' } }
  })
  await vi.waitUntil(() => API_CLIENT.get.mock.calls.length >= 1)

  return { wrapper }
}

/**
 * OpenProject #953: the search watcher called `load({ page: 1 })` directly but left
 * `state.currentPage` (bound to `w-pagination`) at whatever it was -- typing a search while on page 3
 * fetched page 1 of the filtered results while the pager kept highlighting page 3.
 */
describe('AdminUsers search resets the pager (OpenProject #953)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resets state.currentPage to 1 when a search is typed while on a later page', async () => {
    const { wrapper } = await mountPage()

    // -> Lands on page 3 the same way a reader would: clicking a pager button, which is what drives
    //    `state.currentPage` via the `currentPage` watcher's own `load()` call.
    const pageThreeBtn = wrapper.findAll('button').find((b) => b.text() === '3')
    await pageThreeBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length >= 2)
    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'users',
      expect.objectContaining({ searchParams: expect.objectContaining({ page: 3 }) })
    )

    const search = wrapper.find('input')
    await search.setValue('alice')
    await vi.advanceTimersByTimeAsync(400)
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length >= 3)

    // -> The pager's own v-model, not just the fetched page: `w-pagination` reads directly off this.
    expect(wrapper.vm.state?.currentPage ?? 1).toBe(1)
    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'users',
      expect.objectContaining({
        searchParams: expect.objectContaining({ page: 1, filter: 'alice' })
      })
    )
  })

  it('fetches exactly once for a search typed while on a later page, not twice', async () => {
    const { wrapper } = await mountPage()

    const pageThreeBtn = wrapper.findAll('button').find((b) => b.text() === '3')
    await pageThreeBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length >= 2)
    API_CLIENT.get.mockClear()

    const search = wrapper.find('input')
    await search.setValue('alice')
    // -> The debounce is 400ms; advancing well past it and settling any microtasks it schedules is
    //    what would have caught a second, redundant fetch from the currentPage watcher reacting to
    //    the reset -- one that a shorter wait, or asserting immediately, could miss.
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
  })

  it('does not reset the page (and does not double-fetch) when already on page 1', async () => {
    const { wrapper } = await mountPage()
    API_CLIENT.get.mockClear()

    const search = wrapper.find('input')
    await search.setValue('alice')
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.state?.currentPage ?? 1).toBe(1)
  })
})

/**
 * OpenProject #2064: `AdminUsers` filters server-side, so a no-match search empties `state.users`
 * entirely -- with `hide-header` set on `<w-table>`, that used to be a literally blank white card.
 */
describe('AdminUsers empty state (OpenProject #2064)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the no-match message, not the empty-source message, for a search that returns no rows', async () => {
    const { wrapper } = await mountPage()

    API_CLIENT.get.mockImplementation((_url, opts) =>
      opts?.searchParams?.filter ? usersResponse({ total: 0, users: [] }) : usersResponse()
    )

    const search = wrapper.find('input')
    await search.setValue('nobody-matches-this')
    await vi.advanceTimersByTimeAsync(400)
    await vi.waitUntil(() => wrapper.vm.state?.users?.length === 0)
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('No user matches your search.')
    expect(wrapper.text()).not.toContain('No users have been created yet.')
  })
})
