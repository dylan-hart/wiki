import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminClassification from './AdminClassification.vue'
import { useSiteStore } from '@/stores/site'
import { queue as notifyQueue } from '@/composables/notify'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn(() => ({ onOk: vi.fn() })),
  // -> `.onOk(cb)` runs `cb` at once rather than waiting on a real confirmation dialog's own click --
  //    matches AdminGlossary.test.js's mocking of the same composable.
  confirm: vi.fn(() => ({ onOk: (cb) => cb() }))
}))

const LEVELS = [
  { id: 'level-1', name: 'Public', sortOrder: 0 },
  { id: 'level-2', name: 'Restricted', sortOrder: 1 }
]

const REPORT = [
  { levelId: 'level-1', name: 'Public', count: 3 },
  { levelId: 'level-2', name: 'Restricted', count: 0 }
]

function mountAdminClassification(levels = LEVELS, report = REPORT) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'classification-levels') {
      return { json: () => Promise.resolve(levels) }
    }
    if (url === 'pages/classification-report') {
      return { json: () => Promise.resolve(report) }
    }
    return { json: () => Promise.resolve([]) }
  })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(AdminClassification, { global: { plugins: [i18n] } })
}

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
})

/**
 * OpenProject #1776: these mutation sites all sit behind a `try`/`catch` that reports
 * `apiErrorMessage(err)`, but until `boot/api.js` throws on a 400 (#1758) that catch only fires for a
 * network failure or a non-400 status -- these tests exercise it with exactly that shape, plus the
 * literal 400-envelope shape the two changes together are meant to produce, via a rejected `.json()`.
 */
describe('AdminClassification: load()', () => {
  it('lists every level and report row from the server', async () => {
    const wrapper = mountAdminClassification()
    await flushPromises()

    expect(wrapper.text()).toContain('Public')
    expect(wrapper.text()).toContain('Restricted')
  })
})

describe('AdminClassification: createLevel()', () => {
  it('leaves the list unchanged and surfaces the server message on refusal', async () => {
    const wrapper = mountAdminClassification()
    await flushPromises()
    const getCallsBefore = API_CLIENT.get.mock.calls.length

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.reject({ data: { message: 'Too many classification levels.' } })
    })

    await wrapper.vm.createLevel()
    await flushPromises()

    expect(wrapper.vm.state.levels).toHaveLength(2)
    expect(API_CLIENT.get.mock.calls.length).toBe(getCallsBefore)
    const lastNotification = notifyQueue[notifyQueue.length - 1]
    expect(lastNotification.type).toBe('negative')
    expect(lastNotification.caption).toBe('Too many classification levels.')
  })
})

describe('AdminClassification: commitRename()', () => {
  it('leaves the level name unchanged and surfaces the server message on refusal', async () => {
    const wrapper = mountAdminClassification()
    await flushPromises()

    API_CLIENT.patch.mockReturnValueOnce({
      json: () => Promise.reject({ data: { message: 'That name is already in use.' } })
    })

    const level = wrapper.vm.state.levels[0]
    wrapper.vm.startRename(level)
    wrapper.vm.state.editingName = 'Something Else'
    await wrapper.vm.commitRename(level)
    await flushPromises()

    expect(level.name).toBe('Public')
    const lastNotification = notifyQueue[notifyQueue.length - 1]
    expect(lastNotification.type).toBe('negative')
    expect(lastNotification.caption).toBe('That name is already in use.')
  })
})

describe('AdminClassification: move()', () => {
  it('reloads the original order and surfaces the server message when persisting the reorder fails', async () => {
    const wrapper = mountAdminClassification()
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.reject({ data: { message: 'Could not reorder levels.' } })
    })

    await wrapper.vm.move(1, -1)
    await flushPromises()

    expect(wrapper.vm.state.levels.map((l) => l.id)).toEqual(['level-1', 'level-2'])
    const lastNotification = notifyQueue[notifyQueue.length - 1]
    expect(lastNotification.type).toBe('negative')
    expect(lastNotification.caption).toBe('Could not reorder levels.')
  })
})

describe('AdminClassification: deleteLevel()', () => {
  // -> The WP #1754/#1776 worked case: deleting the last classification level throws
  //    `classificationLastLevel` (`backend/models/classificationLevels.ts`), a 400 -- today that
  //    resolves rather than throws (`boot/api.js`'s `throwHttpErrors`, flipped only by #1758), so the
  //    reject here is standing in for what a real 400 will look like once that lands; the assertion is
  //    on the catch this component already has, not on the enabling change.
  it("shows the server's message and leaves the level in the list instead of closing silently", async () => {
    const wrapper = mountAdminClassification([LEVELS[0]], [REPORT[0]])
    await flushPromises()
    const getCallsBefore = API_CLIENT.get.mock.calls.length

    API_CLIENT.delete.mockReturnValueOnce({
      json: () =>
        Promise.reject({ data: { message: 'At least one classification level must exist.' } })
    })

    await wrapper.vm.deleteLevel(wrapper.vm.state.levels[0])
    await flushPromises()

    expect(wrapper.vm.state.levels).toHaveLength(1)
    expect(API_CLIENT.get.mock.calls.length).toBe(getCallsBefore)
    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0].type).toBe('negative')
    expect(notifyQueue[0].caption).toBe('At least one classification level must exist.')
  })

  it('removes the level and reloads on success', async () => {
    const wrapper = mountAdminClassification()
    await flushPromises()
    const getCallsBefore = API_CLIENT.get.mock.calls.length

    API_CLIENT.delete.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'classification-levels') {
        return { json: () => Promise.resolve([LEVELS[1]]) }
      }
      return { json: () => Promise.resolve([REPORT[1]]) }
    })

    await wrapper.vm.deleteLevel(wrapper.vm.state.levels[0])
    await flushPromises()

    expect(API_CLIENT.get.mock.calls.length).toBe(getCallsBefore + 2)
    expect(wrapper.vm.state.levels).toEqual([LEVELS[1]])
  })
})
