import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminClassification from './AdminClassification.vue'

/**
 * OpenProject #1671: the rename field's `autofocus` attribute on `<w-input>` never did anything --
 * `WInput.vue` exposes no such prop, so the field stayed unfocused until the reader clicked into it
 * themselves. `startRename()` now focuses it itself, via the `focus()` method `WInput.vue` exposes.
 */

const LEVEL = { id: 'lvl-1', name: 'Internal', sortOrder: 0 }

async function mountPage() {
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

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        common: { actions: { rename: 'Rename' } }
      }
    }
  })

  const wrapper = mount(AdminClassification, {
    attachTo: document.body,
    global: { plugins: [i18n] }
  })
  await flushPromises()

  return wrapper
}

describe('AdminClassification rename focus', () => {
  it('focuses the rename field once it appears, without an inert autofocus attribute', async () => {
    const wrapper = await mountPage()

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
