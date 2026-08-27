import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminClassification from './AdminClassification.vue'
import { useSiteStore } from '@/stores/site'
import { dialog } from '@/composables/dialog'

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

async function mountPage(report = REPORT) {
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

beforeEach(() => {
  dialog.mockClear()
})

describe('AdminClassification: openReport()', () => {
  it('opens no drill-down dialog when clicking a zero-count level', async () => {
    const wrapper = await mountPage()

    const rows = wrapper.findAll('.w-item')
    // -> First row is the zero-count level, per REPORT above
    await rows[0].trigger('click')

    expect(dialog).not.toHaveBeenCalled()
  })

  it('opens the drill-down dialog when clicking a level with a nonzero count', async () => {
    const wrapper = await mountPage()

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
