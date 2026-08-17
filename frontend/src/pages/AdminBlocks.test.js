import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminBlocks from './AdminBlocks.vue'
import { useAdminStore } from '@/stores/admin'

/**
 * Covers Task 657: the per-block "Configure" affordance in the admin blocks list, and `save()`
 * carrying `config` through to the PUT payload alongside `id` / `isEnabled`.
 */

function makeBlocks() {
  return [
    {
      id: 'block-map',
      block: 'map',
      name: 'Map',
      description: 'An interactive map',
      icon: 'map',
      isEnabled: true,
      isCustom: false,
      // -> Only `tileServerUrl` has been set by this site; `apiKey` has never been touched
      config: { tileServerUrl: 'https://example.com/{z}/{x}/{y}.png' },
      configFields: [
        {
          name: 'tileServerUrl',
          type: 'string',
          default: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
        },
        { name: 'apiKey', type: 'string' }
      ],
      props: [],
      template: ''
    },
    {
      id: 'block-alert',
      block: 'alert',
      name: 'Alert',
      description: 'A callout box',
      icon: 'alert',
      isEnabled: true,
      isCustom: false,
      config: {},
      configFields: [],
      props: [],
      template: ''
    }
  ]
}

async function mountAdminBlocks(blocks) {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(blocks) })

  // -> No `en` messages loaded: vue-i18n's `t()` falls back to returning the key itself when a
  //    translation is missing, which is what HeaderSearch.test.js's mount helper also relies on
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(AdminBlocks, {
    global: {
      plugins: [i18n],
      // -> Registered by `boot/components.js` in the real app, not by the shared-component map
      //    `test/setup.js` installs; stubbed so mounting the page does not warn about it
      stubs: { BlueprintIcon: true }
    }
  })

  await flushPromises()
  return wrapper
}

describe('AdminBlocks Configure affordance', () => {
  it('shows a Configure button only for blocks that declare config fields', async () => {
    const wrapper = await mountAdminBlocks(makeBlocks())

    const configureButtons = wrapper
      .findAll('button')
      .filter((btn) => btn.text() === 'admin.blocks.configure')

    expect(configureButtons).toHaveLength(1)
  })
})

describe('AdminBlocks save()', () => {
  it("includes each block's config in the PUT payload alongside id and isEnabled", async () => {
    const wrapper = await mountAdminBlocks(makeBlocks())

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    const applyButton = wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'common.actions.apply')
    expect(applyButton).toBeTruthy()

    await applyButton.trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/blocks', {
      json: {
        states: [
          {
            id: 'block-map',
            isEnabled: true,
            config: { tileServerUrl: 'https://example.com/{z}/{x}/{y}.png' }
          },
          { id: 'block-alert', isEnabled: true, config: {} }
        ]
      }
    })
  })
})
