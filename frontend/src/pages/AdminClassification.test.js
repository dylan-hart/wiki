import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminClassification from './AdminClassification.vue'
import { useSiteStore } from '@/stores/site'
import { confirm, dialog } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn(() => ({ onOk: vi.fn() })),
  // -> `.onOk(cb)` runs `cb` at once rather than waiting on a real confirmation dialog's own click --
  //    matches AdminGlossary.test.js's mocking of the same composable.
  confirm: vi.fn(() => ({ onOk: (cb) => cb() }))
}))

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
})

/**
 * OpenProject #1731: `createLevel()` posts and awaits with its trigger button live throughout --
 * unlike every other write on this page, nothing blocked a second click from firing a second
 * identical POST before the first round trip (and its `load()` refresh) completed.
 */
function mountPage() {
  setActivePinia(createPinia())

  const i18n = createTestI18n({
    'admin.classification.title': 'Classification',
    'admin.classification.new': 'New Level',
    'admin.classification.newDefaultName': 'New Level'
  })

  return mount(AdminClassification, {
    global: {
      plugins: [i18n]
    }
  })
}

function findNewLevelButton(wrapper) {
  return wrapper.findAll('button').find((btn) => btn.text().includes('New Level'))
}

/** Lets the page's own `onMounted(() => load())` round trip settle before a test drives it. */
async function flush(wrapper) {
  await wrapper.vm.$nextTick()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

describe('AdminClassification', () => {
  it('issues exactly one POST when the New Level button is clicked twice synchronously', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    // -> Never resolves within this test, so the first click's round trip is still in flight when
    //    the second click fires -- exactly the window the double-submit guard has to hold shut.
    API_CLIENT.post.mockReturnValue({ json: () => new Promise(() => {}) })

    const wrapper = mountPage()
    await flush(wrapper)

    const newLevelBtn = findNewLevelButton(wrapper)
    expect(newLevelBtn).toBeTruthy()

    // -> `trigger()` dispatches its DOM event synchronously before returning a `nextTick()` promise,
    //    so calling it twice before awaiting either dispatches both clicks back-to-back with no
    //    render cycle in between -- the guard has to hold on `state.isLoading` itself, not on the
    //    button's `disabled` attribute having had a chance to catch up.
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

/**
 * OpenProject #1789: `WItem.vue` declares `disabled`, not `disable`, so the template's
 * `:disable="row.count === 0"` landed as an inert non-standard attribute -- clicking a zero-count
 * row still ran `openReport()` and opened an empty drill-down. `openReport()` itself now guards on
 * `row.count === 0` as belt-and-braces, alongside the template's rename to `:disabled` (covered by
 * `WItem.test.js`'s own click-blocking assertions).
 */

const DRILLDOWN_REPORT = [
  { levelId: 'l1', name: 'Public', count: 0 },
  { levelId: 'l2', name: 'Internal', count: 3 }
]

async function mountReportPage(report = DRILLDOWN_REPORT) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.docsBase = 'https://docs.js.wiki'

  API_CLIENT.get.mockImplementation((url) => {
    if (String(url).includes('classification-report')) {
      return { json: () => Promise.resolve(report) }
    }
    return { json: () => Promise.resolve([]) }
  })

  const i18n = createTestI18n()
  const wrapper = mount(AdminClassification, { global: { plugins: [i18n] } })
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
    // -> First row is the zero-count level, per DRILLDOWN_REPORT above
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

  const i18n = createTestI18n()

  return mount(AdminClassification, { global: { plugins: [i18n] } })
}

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

/**
 * OpenProject #2039: `deleteLevel()` used to call `confirm({ title, message })` with no `cancel`,
 * `color`, or `okLabel` -- a one-button, primary-blue prompt for an irreversible delete, identical in
 * appearance to a safe confirmation. It now matches the reference treatment (`AdminIcons.vue`'s
 * `confirmDeleteSet()`): `persistent: true, cancel: true, color: 'negative', okLabel:
 * t('common.actions.delete')`. `confirm` is mocked file-wide (above), so this asserts on the call
 * itself rather than on `openDialogs`, which the mock never populates.
 */
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

/**
 * OpenProject #1671: the rename field's `autofocus` attribute on `<w-input>` never did anything --
 * `WInput.vue` exposes no such prop, so the field stayed unfocused until the reader clicked into it
 * themselves. `startRename()` now focuses it itself, via the `focus()` method `WInput.vue` exposes.
 */
describe('AdminClassification rename focus', () => {
  it('focuses the rename field once it appears, without an inert autofocus attribute', async () => {
    const LEVEL = { id: 'lvl-1', name: 'Internal', sortOrder: 0 }
    setActivePinia(createPinia())

    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'classification-levels') {
        return { json: () => Promise.resolve([LEVEL]) }
      }
      if (url === 'pages/classification-report') {
        return { json: () => Promise.resolve([]) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const i18n = createTestI18n({
      common: { actions: { rename: 'Rename' } }
    })

    const wrapper = mount(AdminClassification, {
      attachTo: document.body,
      global: { plugins: [i18n] }
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

/**
 * OpenProject #1929: `/admin/classification` names a classification-guardrail concept this fork
 * invented (no upstream Wiki.js docs site can describe it), so the `docsBase`-based help button was
 * deleted rather than left pointing at a page that does not exist. Reads the raw source rather than
 * mounting the component -- a full mount is out of proportion for asserting that some markup is
 * simply gone -- so this also guards against the button quietly being reintroduced.
 */
const source = readFileSync(join(import.meta.dirname, 'AdminClassification.vue'), 'utf-8')

describe('AdminClassification help link', () => {
  it('has no docsBase-based help/docs button', () => {
    expect(source).not.toContain('docsBase')
  })
})
