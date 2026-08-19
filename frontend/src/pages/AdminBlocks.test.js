import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminBlocks from './AdminBlocks.vue'
import WBtn from '@/components/shared/WBtn.vue'
import WInput from '@/components/shared/WInput.vue'
import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'

/**
 * Regression coverage for the admin "Content Blocks" page's per-block "Server" field: only a block
 * whose definition declares one via `props` (block-kroki, block-plantuml) gets one, editing it writes
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
  configFields: [],
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
  configFields: [],
  props: [{ name: 'columns', type: 'number', label: 'Columns', default: 3 }],
  template: ''
}

async function mountAdminBlocks(blocks) {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  // -> useSiteAdminAccess('site:blocks') needs a real route (for its `siteid` param) and a
  //    permission that satisfies GLOBAL_FALLBACKS['site:blocks'], so this mount neither warns on a
  //    missing router injection nor redirects away mid-test.
  const userStore = useUserStore()
  userStore.permissions = ['manage:sites']

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/_admin/:siteid/blocks', component: { template: '<div />' } }]
  })
  router.push('/_admin/site-1/blocks')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(blocks) })

  const wrapper = mount(AdminBlocks, {
    global: {
      plugins: [router, i18n],
      // -> Registered by `boot/components.js` in the real app, not by the shared-component map
      //    `test/setup.js` installs; stubbed so mounting the page does not warn about it
      stubs: { BlueprintIcon: true }
    }
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

/**
 * Covers Task 657: the per-block "Configure" affordance in the admin blocks list, driven by
 * `configFields` (the site-level admin-config-field schema from the block's manifest — see
 * `models/blocks.ts`'s `getSiteBlocks()`), and `save()` carrying `config` through to the PUT payload
 * alongside `id` / `isEnabled`. Independent of the inline "Server" field above, which is driven by
 * `props` instead — a block can have either, both, or neither.
 */
function makeConfigureBlocks() {
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

describe('AdminBlocks Configure affordance', () => {
  it('shows a Configure button only for blocks that declare config fields', async () => {
    const wrapper = await mountAdminBlocks(makeConfigureBlocks())

    const configureButtons = wrapper
      .findAll('button')
      .filter((btn) => btn.text() === 'admin.blocks.configure')

    expect(configureButtons).toHaveLength(1)
  })
})

describe('AdminBlocks save()', () => {
  it("includes each block's config in the PUT payload alongside id and isEnabled", async () => {
    const wrapper = await mountAdminBlocks(makeConfigureBlocks())

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    const applyButton = wrapper
      .findAllComponents(WBtn)
      .find((btn) => btn.props('icon') === 'mdi:check')
    expect(applyButton).toBeTruthy()

    await applyButton.trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      'sites/site-1/blocks',
      expect.objectContaining({
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
    )
  })
})
