import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminClassification from './AdminClassification.vue'
import { useSiteStore } from '@/stores/site'
import { dialog } from '@/composables/dialog'

/**
 * OpenProject #1731: `createLevel()` posts and awaits with its trigger button live throughout --
 * unlike every other write on this page, nothing blocked a second click from firing a second
 * identical POST before the first round trip (and its `load()` refresh) completed.
 */
function mountPage() {
  setActivePinia(createPinia())

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        'admin.classification.title': 'Classification',
        'admin.classification.new': 'New Level',
        'admin.classification.newDefaultName': 'New Level'
      }
    }
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

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn(() => ({ onOk: vi.fn() }))
}))

const REPORT = [
  { levelId: 'l1', name: 'Public', count: 0 },
  { levelId: 'l2', name: 'Internal', count: 3 }
]

async function mountReportPage(report = REPORT) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.docsBase = 'https://docs.js.wiki'

  API_CLIENT.get.mockImplementation((url) => {
    if (String(url).includes('classification-report')) {
      return { json: () => Promise.resolve(report) }
    }
    return { json: () => Promise.resolve([]) }
  })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
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
    // -> First row is the zero-count level, per REPORT above
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
