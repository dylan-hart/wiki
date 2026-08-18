import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminBlocks from './AdminBlocks.vue'
import WBtn from '@/components/shared/WBtn.vue'
import WInput from '@/components/shared/WInput.vue'
import { useAdminStore } from '@/stores/admin'

/**
 * Regression coverage for the admin "Content Blocks" page's per-block "Server" field: only a block
 * whose definition declares a `server` prop (block-kroki, block-plantuml) gets one, editing it writes
 * into that block's `config`, and Apply sends `config` alongside `isEnabled` for every block — the
 * PUT-side wiring `models/blocks.ts#setBlocksState` and `api/blocks.ts` persist (see their own tests
 * for the write-side logic itself).
 */

const KROKI_BLOCK = {
  id: 'kroki-id',
  block: 'kroki',
  name: 'Kroki',
  description: 'Draws a diagram through a Kroki server.',
  icon: 'tree-structure',
  isEnabled: true,
  isCustom: false,
  config: { server: 'https://kroki.example.com' },
  props: [{ name: 'server', type: 'string', label: 'Server', default: 'https://kroki.io' }],
  template: ''
}

const GALLERY_BLOCK = {
  id: 'gallery-id',
  block: 'gallery',
  name: 'Gallery',
  description: 'A gallery of images.',
  icon: 'image',
  isEnabled: true,
  isCustom: false,
  config: {},
  props: [{ name: 'columns', type: 'number', label: 'Columns', default: 3 }],
  template: ''
}

async function mountAdminBlocks(blocks) {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(blocks) })

  const wrapper = mount(AdminBlocks, {
    global: { plugins: [i18n] }
  })
  await flushPromises()
  return wrapper
}

describe('AdminBlocks', () => {
  it('shows a Server field only for a block whose definition declares one', async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK, GALLERY_BLOCK])

    const inputs = wrapper.findAllComponents(WInput)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].props('modelValue')).toBe('https://kroki.example.com')
  })

  it("sends every block's config, alongside isEnabled, when Apply is clicked", async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK, GALLERY_BLOCK])
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    const serverInput = wrapper.findComponent(WInput)
    await serverInput.vm.$emit('update:modelValue', 'https://kroki.internal.example.com')

    const applyButton = wrapper
      .findAllComponents(WBtn)
      .find((btn) => btn.props('icon') === 'mdi:check')
    await applyButton.trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      'sites/site-1/blocks',
      expect.objectContaining({
        json: {
          states: [
            {
              id: 'kroki-id',
              isEnabled: true,
              config: { server: 'https://kroki.internal.example.com' }
            },
            { id: 'gallery-id', isEnabled: true, config: {} }
          ]
        }
      })
    )
  })
})
