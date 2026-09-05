import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminBlocks from './AdminBlocks.vue'
import WBanner from '@/components/shared/WBanner.vue'
import WBtn from '@/components/shared/WBtn.vue'
import WInput from '@/components/shared/WInput.vue'
import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'
import { closeDialog, dialog, openDialogs } from '@/composables/dialog'
import { loading } from '@/composables/loading'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn(() => ({ onOk: vi.fn() }))
}))

vi.mock('@/composables/loading', async (importOriginal) => ({
  ...(await importOriginal()),
  loading: { show: vi.fn(), hide: vi.fn() }
}))

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
  // -> WP #1745: block-kroki now declares `server` on `config` too (as well as `props`), so the site's
  //    saved value actually survives a save instead of being stripped by `sanitizeConfig`.
  configFields: [{ name: 'server', type: 'string', label: 'Server', default: 'https://kroki.io' }],
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

async function mountAdminBlocks(blocks, credentials = [], siteId = 'site-1') {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = siteId

  // -> useSiteAdminAccess('site:blocks') needs a real route (for its `siteid` param) and a
  //    permission that satisfies GLOBAL_FALLBACKS['site:blocks'], so this mount neither warns on a
  //    missing router injection nor redirects away mid-test.
  const userStore = useUserStore()
  userStore.permissions = ['manage:sites']

  const router = await createTestRouter(['/_admin/:siteid/blocks'], '/_admin/site-1/blocks')

  const i18n = createTestI18n()

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(blocks) })
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(credentials) })

  const wrapper = mount(AdminBlocks, {
    global: {
      plugins: [router, i18n]
      // -> Registered by `boot/components.js` in the real app, not by the shared-component map
      //    `test/setup.js` installs; stubbed so mounting the page does not warn about it
    }
  })
  await flushPromises()
  return wrapper
}

/*
 * OpenProject #829 item 5: upstream discussions #3275/#7258/#7229 all describe the same dead end --
 * an author reaches for Kroki or PlantUML, the block quietly draws against the project's own public
 * demo server, and nothing on this page said so until it rate-limited, went down, or the diagram
 * turned out to carry something the author would rather not have sent to a third party.
 */
describe('AdminBlocks: self-hosted server note (OpenProject #829 item 5)', () => {
  it('shows the self-hosted server note when a block on this site declares a Server field', async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK, GALLERY_BLOCK])

    expect(wrapper.findComponent(WBanner).exists()).toBe(true)
  })

  it('does not show the note when no block on this site declares a Server field', async () => {
    const wrapper = await mountAdminBlocks([GALLERY_BLOCK])

    expect(wrapper.findComponent(WBanner).exists()).toBe(false)
  })
})

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
      .find((btn) => btn.props('icon') === 'tabler:check')
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

  /**
   * WP #1745: block-kroki's only config field is `server`, and that field already has a dedicated
   * inline input (`hasServerProp`) -- so the generic Configure button, which would otherwise open a
   * second editor for the exact same setting, stays hidden for it.
   */
  it('does not show a Configure button for a block whose only config field is the dedicated Server field', async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK])

    const configureButtons = wrapper
      .findAll('button')
      .filter((btn) => btn.text() === 'admin.blocks.configure')

    expect(configureButtons).toHaveLength(0)
  })
})

/**
 * OpenProject #2356: the per-block "Configure" dialog's `role="dialog"` panel gets a real accessible
 * name via `WDialog`'s `aria-label`, reusing the exact expression already shown as the visible
 * `text-h6` header -- rather than staying unnamed for assistive tech, as every `<w-dialog>` in the app
 * did before WP #1617's infrastructure was actually wired up to a call site.
 */
describe('AdminBlocks configure dialog accessible name', () => {
  it("gives the configure dialog's panel a non-empty aria-label naming the block", async () => {
    const wrapper = await mountAdminBlocks(makeConfigureBlocks())

    const configureBtn = wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'admin.blocks.configure')
    await configureBtn.trigger('click')
    await flushPromises()

    const panel = document.body.querySelector('[role="dialog"]')
    expect(panel).not.toBeNull()
    expect(panel.getAttribute('aria-label')).toBeTruthy()
  })
})

/**
 * OpenProject #868: the per-site block credentials list. `state.credentials` is loaded from
 * `GET sites/:siteId/block-credentials` inside `load()`, alongside the blocks list itself.
 */
describe('AdminBlocks credentials list', () => {
  it("shows each credential's name and id, and never a secret field", async () => {
    const wrapper = await mountAdminBlocks(
      [],
      [{ id: 'cred-1', siteId: 'site-1', name: 'Weather API', createdAt: '', updatedAt: '' }]
    )

    expect(wrapper.text()).toContain('Weather API')
    expect(wrapper.text()).toContain('cred-1')
    expect(wrapper.html()).not.toContain('secret')
  })

  it('shows the empty-state message when the site has no credentials', async () => {
    const wrapper = await mountAdminBlocks([], [])

    expect(wrapper.text()).toContain('admin.blocks.credentialsEmpty')
  })

  it('opens BlockCredentialDialog in mode "domains" with the clicked credential when Edit Domains is clicked', async () => {
    const wrapper = await mountAdminBlocks(
      [],
      [
        {
          id: 'cred-1',
          siteId: 'site-1',
          name: 'Weather API',
          allowedOrigins: ['https://api.example.com'],
          createdAt: '',
          updatedAt: ''
        }
      ]
    )

    const editDomainsBtn = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('admin.blocks.credentialDomains'))
    expect(editDomainsBtn).toBeTruthy()
    await editDomainsBtn.trigger('click')

    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: {
          mode: 'domains',
          credential: {
            id: 'cred-1',
            siteId: 'site-1',
            name: 'Weather API',
            allowedOrigins: ['https://api.example.com'],
            createdAt: '',
            updatedAt: ''
          }
        }
      })
    )
  })
})

/**
 * OpenProject #2039: `deleteCredential()` and `deleteBlock()` used to pass `cancel: true, persistent:
 * true` but never `color`/`okLabel`, leaving a primary-blue OK on an irreversible delete. Both now
 * match the reference treatment (`AdminIcons.vue`'s `confirmDeleteSet()`).
 */
describe('AdminBlocks destructive confirmations', () => {
  it('deleteCredential() opens a negative-coloured, delete-labelled confirmation', async () => {
    const wrapper = await mountAdminBlocks(
      [],
      [{ id: 'cred-1', siteId: 'site-1', name: 'Weather API', createdAt: '', updatedAt: '' }]
    )

    const deleteBtn = wrapper.find('[aria-label="common.actions.delete"]')
    expect(deleteBtn.exists()).toBe(true)
    await deleteBtn.trigger('click')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props.color).toBe('negative')
    expect(openDialogs[0].props.cancel).toBe(true)
    expect(openDialogs[0].props.okLabel).toBe('common.actions.delete')

    closeDialog(openDialogs[0].id, false)
  })

  it('deleteBlock() opens a negative-coloured, delete-labelled confirmation', async () => {
    const customBlock = {
      id: 'custom-1',
      block: 'custom-block',
      name: 'Custom Block',
      description: 'A custom block',
      icon: 'puzzle-piece',
      isEnabled: true,
      isCustom: true,
      config: {},
      configFields: [],
      props: [],
      template: ''
    }
    const wrapper = await mountAdminBlocks([customBlock])

    const deleteBtn = wrapper.find('[aria-label="common.actions.delete"]')
    expect(deleteBtn.exists()).toBe(true)
    await deleteBtn.trigger('click')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props.color).toBe('negative')
    expect(openDialogs[0].props.cancel).toBe(true)
    expect(openDialogs[0].props.okLabel).toBe('common.actions.delete')

    closeDialog(openDialogs[0].id, false)
  })
})

/**
 * OpenProject #1736: `onMounted` used to call `loading.show()` unconditionally, before the
 * `if (adminStore.currentSiteId)` test that gates the `load()` call which would hide it again. On a
 * zero-site instance (`currentSiteId` null) that left the full-screen overlay stuck on forever, with
 * nothing in the UI explaining why. `loading.show()` must now be inside that branch.
 */
describe('AdminBlocks: loading overlay on mount (OpenProject #1736)', () => {
  it('does not show the loading overlay when adminStore.currentSiteId is null', async () => {
    loading.show.mockClear()
    await mountAdminBlocks([], [], null)

    expect(loading.show).not.toHaveBeenCalled()
  })

  it('does show the loading overlay when adminStore.currentSiteId is set', async () => {
    loading.show.mockClear()
    await mountAdminBlocks([], [], 'site-1')

    expect(loading.show).toHaveBeenCalled()
  })
})

describe('AdminBlocks save()', () => {
  it("includes each block's config in the PUT payload alongside id and isEnabled", async () => {
    const wrapper = await mountAdminBlocks(makeConfigureBlocks())

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    const applyButton = wrapper
      .findAllComponents(WBtn)
      .find((btn) => btn.props('icon') === 'tabler:check')
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
