import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageHeader from './PageHeader.vue'
import { useEditorStore } from '@/stores/editor'
import { useCollabStore } from '@/stores/collab'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

const messages = {
  editor: {
    collab: {
      disconnected:
        'Live collaboration is unavailable. Your changes are kept locally and can still be saved.'
    }
  }
}

/**
 * Split into its own file rather than folded into a hypothetical broader `PageHeader.test.js`: this
 * only exercises the task 480 indicator, not the rest of the (971-line) header.
 */
async function mountHeader() {
  setActivePinia(createPinia())
  const editorStore = useEditorStore()
  editorStore.isActive = true
  editorStore.editor = 'markdown'
  const collabStore = useCollabStore()

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n(messages)

  const wrapper = mount(PageHeader, { global: { plugins: [router, i18n] } })
  return { wrapper, collabStore }
}

describe('PageHeader collab-disconnected indicator', () => {
  it('is absent while the session is off, connecting or connected', async () => {
    const { wrapper, collabStore } = await mountHeader()

    for (const status of ['off', 'connecting', 'connected']) {
      collabStore.status = status
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.collab-disconnected').exists()).toBe(false)
    }
  })

  it('appears, persistently, while status is disconnected -- and clears on reconnect', async () => {
    const { wrapper, collabStore } = await mountHeader()

    collabStore.status = 'disconnected'
    await wrapper.vm.$nextTick()

    const indicator = wrapper.find('.collab-disconnected')
    expect(indicator.exists()).toBe(true)
    expect(indicator.attributes('role')).toBe('status')
    expect(indicator.text()).toContain(
      'Live collaboration is unavailable. Your changes are kept locally and can still be saved.'
    )

    collabStore.status = 'connected'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.collab-disconnected').exists()).toBe(false)
  })
})
