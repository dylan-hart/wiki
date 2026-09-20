import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import ClassificationResolutionDialog from './ClassificationResolutionDialog.vue'
import { useSiteStore } from '@/stores/site'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

async function mountDialog(conflicts) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const i18n = createTestI18n()
  const wrapper = mount(ClassificationResolutionDialog, {
    props: { conflicts, floorClassification: 'level-restricted' },
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
  // -> `useDialogComponent()` mounts hidden and flips visible on the next tick, and `WDialog`
  //    renders its panel only while open -- the rows do not exist in the DOM until this resolves
  await flushPromises()

  return { wrapper, siteStore }
}

const CONFLICTS = [
  { id: 'page-1', path: 'docs/child-one', title: 'Child One', classification: 'level-public' },
  { id: 'page-2', path: 'docs/child-two', title: 'Child Two', classification: 'level-public' }
]

describe('ClassificationResolutionDialog', () => {
  it('lists every conflict by title and path', async () => {
    const { wrapper } = await mountDialog(CONFLICTS)
    const text = wrapper.text()
    expect(text).toContain('Child One')
    expect(text).toContain('docs/child-one')
    expect(text).toContain('Child Two')
    expect(text).toContain('docs/child-two')
  })

  it('bumping one row resolves only that page against the floor classification', async () => {
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, updated: 1 })
    })
    const { wrapper } = await mountDialog(CONFLICTS)

    await wrapper.vm.bumpOne(wrapper.vm.state.items[0])
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'sites/site-1/pages/classification-conflicts/resolve',
      { json: { pageIds: ['page-1'], classification: 'level-restricted' } }
    )
    expect(wrapper.vm.state.items[0].resolved).toBe(true)
    expect(wrapper.vm.state.items[1].resolved).toBe(false)
  })

  it('bump all resolves every unresolved page in one call', async () => {
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, updated: 2 })
    })
    const { wrapper } = await mountDialog(CONFLICTS)

    await wrapper.vm.bumpAll()
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'sites/site-1/pages/classification-conflicts/resolve',
      { json: { pageIds: ['page-1', 'page-2'], classification: 'level-restricted' } }
    )
    expect(wrapper.vm.state.items.every((i) => i.resolved)).toBe(true)
  })

  it('bump all skips pages already resolved individually', async () => {
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true, updated: 1 }) })
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true, updated: 1 }) })
    const { wrapper } = await mountDialog(CONFLICTS)

    await wrapper.vm.bumpOne(wrapper.vm.state.items[0])
    await flushPromises()
    await wrapper.vm.bumpAll()
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(2)
    expect(API_CLIENT.post).toHaveBeenLastCalledWith(
      'sites/site-1/pages/classification-conflicts/resolve',
      { json: { pageIds: ['page-2'], classification: 'level-restricted' } }
    )
  })

  it('a failed bump leaves the row unresolved rather than throwing', async () => {
    API_CLIENT.post.mockImplementationOnce(() => {
      throw new Error('network error')
    })
    const { wrapper } = await mountDialog(CONFLICTS)

    await wrapper.vm.bumpOne(wrapper.vm.state.items[0])
    await flushPromises()

    expect(wrapper.vm.state.items[0].resolved).toBe(false)
  })

  // -> A refused write (e.g. a page whose `write:pages` was revoked between the raising save and the
  //    resolve) carries the server's own explanation on `err.data.message`, which `apiErrorMessage`
  //    reads; `err.message` alone is ky's generic "Request failed with status code 400"
  it("surfaces the server's own message, not ky's generic one, on a refused bump", async () => {
    const queueLengthBefore = notifyQueue.length
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.reject({ data: { message: 'You may no longer edit this page.' } })
    })
    const { wrapper } = await mountDialog(CONFLICTS)

    await wrapper.vm.bumpOne(wrapper.vm.state.items[0])
    await flushPromises()

    expect(wrapper.vm.state.items[0].resolved).toBe(false)
    const lastNotification = notifyQueue[notifyQueue.length - 1]
    expect(notifyQueue.length).toBe(queueLengthBefore + 1)
    expect(lastNotification.type).toBe('negative')
    expect(lastNotification.caption).toBe('You may no longer edit this page.')
  })
})
