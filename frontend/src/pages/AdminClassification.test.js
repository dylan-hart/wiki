import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminClassification from './AdminClassification.vue'
import { closeDialog, openDialogs } from '@/composables/dialog'

/**
 * OpenProject #2039: `deleteLevel()` used to call `confirm({ title, message })` with no `cancel`,
 * `color`, or `okLabel` -- a one-button, primary-blue prompt for an irreversible delete, identical in
 * appearance to a safe confirmation. It now matches the reference treatment (`AdminIcons.vue`'s
 * `confirmDeleteSet()`): `persistent: true, cancel: true, color: 'negative', okLabel:
 * t('common.actions.delete')`.
 */

const LEVELS = [
  { id: 'level-1', name: 'Public', sortOrder: 0 },
  { id: 'level-2', name: 'Internal', sortOrder: 1 }
]

async function mountPage() {
  setActivePinia(createPinia())

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: { common: { actions: { delete: 'Delete' } } } }
  })

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(LEVELS) })
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })

  const wrapper = mount(AdminClassification, {
    global: { plugins: [router, i18n] }
  })
  await flushPromises()
  return wrapper
}

describe('AdminClassification deleteLevel confirmation', () => {
  it('opens a negative-coloured, cancelable, delete-labelled confirmation', async () => {
    const wrapper = await mountPage()

    const deleteBtn = wrapper.find('[aria-label="Delete"]')
    expect(deleteBtn.exists()).toBe(true)
    await deleteBtn.trigger('click')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props.color).toBe('negative')
    expect(openDialogs[0].props.cancel).toBe(true)
    expect(openDialogs[0].props.persistent).toBe(true)
    expect(openDialogs[0].props.okLabel).toBe('Delete')

    closeDialog(openDialogs[0].id, false)
  })
})
