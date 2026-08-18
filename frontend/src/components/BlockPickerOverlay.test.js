import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import BlockPickerOverlay from './BlockPickerOverlay.vue'

/**
 * Regression coverage for the picker starting a newly-selected block's form on the site's configured
 * default (`block.config`, written by the admin "Content Blocks" page's per-block "Server" field —
 * see `models/blocks.ts#setBlocksState`) rather than always on the component's own hardcoded
 * `prop.default`. `helpers/blocks.js#propDefault` carries the actual precedence logic and has its own
 * direct unit coverage via `helpers/markdownBlocks.test.js`; this locks down that the picker's
 * `select()` really calls it, by reading the generated markdown back out of the panel.
 */

const BLOCK = {
  id: 'block-1',
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

async function mountPicker(blocks) {
  setActivePinia(createPinia())
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(blocks) })

  const wrapper = mount(BlockPickerOverlay, {
    global: { plugins: [i18n] }
  })
  await flushPromises()
  return wrapper
}

describe('BlockPickerOverlay', () => {
  it("starts a selected block's form on the site's configured default, not the component's own", async () => {
    const wrapper = await mountPicker([BLOCK])

    await wrapper.find('.block-picker-card').trigger('click')

    expect(wrapper.find('.block-picker-output').text()).toContain(
      'server="https://kroki.example.com"'
    )
  })

  it("falls back to the component's own default when the site has not configured one", async () => {
    const wrapper = await mountPicker([{ ...BLOCK, config: {} }])

    await wrapper.find('.block-picker-card').trigger('click')

    // -> Equal to the prop's own default, so `blockAttributes` leaves it out of the markup entirely
    expect(wrapper.find('.block-picker-output').text()).not.toContain('server=')
  })
})
