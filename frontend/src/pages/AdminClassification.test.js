import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AdminClassification from './AdminClassification.vue'
import { confirm, dialog } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn(() => ({ onOk: vi.fn() })),
  // -> `.onOk(cb)` runs `cb` at once rather than waiting on a real dialog's own click
  confirm: vi.fn(() => ({ onOk: (cb) => cb() }))
}))

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
})

function mountPage() {
  return mountWithApp(AdminClassification, {
    messages: {
      'admin.classification.title': 'Classification',
      'admin.classification.new': 'New Level',
      'admin.classification.newDefaultName': 'New Level'
    }
  }).wrapper
}

function findNewLevelButton(wrapper) {
  return wrapper.findAll('button').find((btn) => btn.text().includes('New Level'))
}

async function flush(wrapper) {
  await wrapper.vm.$nextTick()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

describe('AdminClassification', () => {
  it('issues exactly one POST when the New Level button is clicked twice synchronously', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    // -> Never resolves, so the first click's round trip is still in flight when the second fires --
    //    exactly the window the double-submit guard has to hold shut.
    API_CLIENT.post.mockReturnValue({ json: () => new Promise(() => {}) })

    const wrapper = mountPage()
    await flush(wrapper)

    const newLevelBtn = findNewLevelButton(wrapper)
    expect(newLevelBtn).toBeTruthy()

    // -> `trigger()` dispatches synchronously before returning its `nextTick()` promise, so two
    //    calls before awaiting either land back-to-back with no render in between: the guard has to
    //    hold on `state.isLoading`, not on the button's `disabled` attribute catching up.
    const firstClick = newLevelBtn.trigger('click')
    const secondClick = newLevelBtn.trigger('click')
    await firstClick
    await secondClick

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.state.isLoading).toBe(true)

    wrapper.unmount()
  })

  it('re-enables the button and lets a later click through again after a failed create', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.reject(new Error('network'))
    })

    const wrapper = mountPage()
    await flush(wrapper)

    await wrapper.vm.createLevel()
    expect(wrapper.vm.state.isLoading).toBe(false)

    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ id: 'lvl-2' }) })
    await wrapper.vm.createLevel()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(2)

    wrapper.unmount()
  })
})

const DRILLDOWN_REPORT = [
  { levelId: 'l1', name: 'Public', count: 0 },
  { levelId: 'l2', name: 'Internal', count: 3 }
]

async function mountReportPage(report = DRILLDOWN_REPORT) {
  stubApi(new Map([[/classification-report/, report]]), { fallback: [] })

  const { wrapper } = mountWithApp(AdminClassification, {
    stores: { site: { docsBase: 'https://docs.js.wiki' } }
  })
  await flushPromises()

  return wrapper
}

describe('AdminClassification: openReport()', () => {
  beforeEach(() => {
    dialog.mockClear()
  })

  it('opens no drill-down dialog when clicking a zero-count level', async () => {
    const wrapper = await mountReportPage()

    const rows = wrapper.findAll('.w-item')
    await rows[0].trigger('click')

    expect(dialog).not.toHaveBeenCalled()
  })

  it('opens the drill-down dialog when clicking a level with a nonzero count', async () => {
    const wrapper = await mountReportPage()

    const rows = wrapper.findAll('.w-item')
    await rows[1].trigger('click')

    expect(dialog).toHaveBeenCalledTimes(1)
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: { levelId: 'l2', levelName: 'Internal' }
      })
    )
  })
})

const LEVELS = [
  { id: 'level-1', name: 'Public', sortOrder: 0 },
  { id: 'level-2', name: 'Restricted', sortOrder: 1 }
]

const REPORT = [
  { levelId: 'level-1', name: 'Public', count: 3 },
  { levelId: 'level-2', name: 'Restricted', count: 0 }
]

function mountAdminClassification(levels = LEVELS, report = REPORT) {
  stubApi(
    { 'classification-levels': levels, 'pages/classification-report': report },
    { fallback: [] }
  )

  return mountWithApp(AdminClassification, { stores: { site: { id: 'site-1' } } }).wrapper
}

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
    stubApi({ 'classification-levels': [LEVELS[1]] }, { fallback: [REPORT[1]] })

    await wrapper.vm.deleteLevel(wrapper.vm.state.levels[0])
    await flushPromises()

    expect(API_CLIENT.get.mock.calls.length).toBe(getCallsBefore + 2)
    expect(wrapper.vm.state.levels).toEqual([LEVELS[1]])
  })
})

/** `confirm` is mocked file-wide, so this asserts on the call rather than on `openDialogs`. */
describe('AdminClassification deleteLevel confirmation', () => {
  it('opens a negative-coloured, cancelable, delete-labelled confirmation', async () => {
    const wrapper = mountAdminClassification()
    await flushPromises()

    const deleteBtn = wrapper.find('[aria-label="common.actions.delete"]')
    expect(deleteBtn.exists()).toBe(true)
    await deleteBtn.trigger('click')

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        persistent: true,
        cancel: true,
        color: 'negative',
        okLabel: 'common.actions.delete'
      })
    )
  })
})

/** `WInput` exposes no `autofocus` prop, so that attribute would be inert. */
describe('AdminClassification rename focus', () => {
  it('focuses the rename field once it appears, without an inert autofocus attribute', async () => {
    const LEVEL = { id: 'lvl-1', name: 'Internal', sortOrder: 0 }

    stubApi({ 'classification-levels': [LEVEL], 'pages/classification-report': [] })

    const { wrapper } = mountWithApp(AdminClassification, {
      attachTo: document.body,
      messages: {
        common: { actions: { rename: 'Rename' } }
      }
    })
    await flushPromises()

    const renameBtn = wrapper
      .findAll('button')
      .find((btn) => btn.attributes('aria-label') === 'Rename')
    await renameBtn.trigger('click')
    await flushPromises()

    const renameField = wrapper.find('input[type="text"]')
    expect(renameField.exists()).toBe(true)
    expect(renameField.attributes('autofocus')).toBeUndefined()
    expect(document.activeElement).toBe(renameField.element)
  })
})
