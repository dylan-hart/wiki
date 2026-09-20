import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminBlocks from './AdminBlocks.vue'
import WBanner from '@/components/shared/WBanner.vue'
import WBtn from '@/components/shared/WBtn.vue'
import WChip from '@/components/shared/WChip.vue'
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

const KROKI_BLOCK = {
  id: 'kroki-id',
  block: 'kroki',
  name: 'Kroki',
  description: 'Draws a diagram through a Kroki server.',
  icon: 'tabler:topology-star',
  isEnabled: true,
  isCustom: false,
  config: { server: 'https://kroki.example.com' },
  // -> `server` is declared on `configFields` as well as `props`: `sanitizeConfig` strips a saved
  //    value that the block's config schema does not declare.
  configFields: [{ name: 'server', type: 'string', label: 'Server', default: 'https://kroki.io' }],
  props: [{ name: 'server', type: 'string', label: 'Server', default: 'https://kroki.io' }],
  template: ''
}

const GALLERY_BLOCK = {
  id: 'gallery-id',
  block: 'gallery',
  name: 'Gallery',
  description: 'A gallery of images.',
  icon: 'tabler:photo',
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

  // -> `useSiteAdminAccess('site:blocks')` needs a real route (for its `siteid` param) and a
  //    satisfying permission, or the mount warns on a missing router and redirects away mid-test.
  const userStore = useUserStore()
  userStore.permissions = ['manage:sites']

  const router = await createTestRouter(['/_admin/:siteid/blocks'], '/_admin/site-1/blocks')

  const i18n = createTestI18n()

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(blocks) })
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(credentials) })

  const wrapper = mount(AdminBlocks, {
    global: {
      plugins: [router, i18n]
    }
  })
  await flushPromises()
  return wrapper
}

/*
 * Unless a self-hosted server is set, the Kroki and PlantUML blocks draw against their project's
 * own public demo server -- a third party the diagram's content is then sent to, and one that can
 * rate-limit or go down. That is what the note says.
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

describe('AdminBlocks: Server field layout (OpenProject #3499)', () => {
  it("stacks the Server field under the block's description, in the same column", async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK])

    const section = wrapper.findComponent(WInput).element.closest('.w-item-section')
    expect(section).not.toBeNull()
    expect(section.classList.contains('w-item-section--main')).toBe(true)
    expect(section.textContent).toContain(KROKI_BLOCK.description)
  })

  it('leaves no fixed-width side column holding the Server field', async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK])

    expect(wrapper.html()).not.toContain('min-width: 260px')
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
 * `configFields` — the site-level admin-config schema from the block's manifest — is independent of
 * the inline "Server" field above, which is driven by `props`: a block can have either, both, or
 * neither.
 */
function makeConfigureBlocks() {
  return [
    {
      id: 'block-map',
      block: 'map',
      name: 'Map',
      description: 'An interactive map',
      icon: 'tabler:map-2',
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
      icon: 'tabler:alert-triangle',
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
   * `server` already has a dedicated inline input, so a generic Configure button would open a
   * second editor for the exact same setting.
   */
  it('does not show a Configure button for a block whose only config field is the dedicated Server field', async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK])

    const configureButtons = wrapper
      .findAll('button')
      .filter((btn) => btn.text() === 'admin.blocks.configure')

    expect(configureButtons).toHaveLength(0)
  })
})

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
 * `loading.show()` must sit inside `onMounted`'s `if (adminStore.currentSiteId)` branch: on a
 * zero-site instance nothing calls `load()` to hide it again, so the full-screen overlay stays on
 * forever with nothing in the UI explaining why.
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

/**
 * `WIcon` stamps `data-icon` on all three of its branches, so this reads the same whether the
 * reference happens to be in the inlined bundle or falls through to `iconify-icon` at runtime.
 */
describe('the block icon', () => {
  it("passes each block's own Iconify reference through to the row's plate", async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK, GALLERY_BLOCK])

    expect(wrapper.find('.blueprint-icon [data-icon="tabler:topology-star"]').exists()).toBe(true)
    expect(wrapper.find('.blueprint-icon [data-icon="tabler:photo"]').exists()).toBe(true)
  })

  it('draws the one fallback glyph for a custom block, whose definition it cannot vouch for', async () => {
    const wrapper = await mountAdminBlocks([
      { ...KROKI_BLOCK, isCustom: true, icon: 'whatever-was-uploaded' }
    ])

    expect(wrapper.find('.blueprint-icon [data-icon="tabler:puzzle"]').exists()).toBe(true)
    expect(wrapper.html()).not.toContain('whatever-was-uploaded')
  })
})

/**
 * These assert only colours, typefaces and DOM order the design states outright: Cardinal names an
 * exact token for each, so a Material-ramp class reappearing on this screen is the regression they
 * guard. Nothing here asserts a height, a padding or a rhythm -- jsdom runs no layout engine.
 */
const CUSTOM_BLOCK = {
  id: 'fleet-id',
  block: 'fleet-status',
  name: 'Fleet status',
  description: 'Uploaded by an administrator for this site.',
  icon: 'plugin',
  isEnabled: true,
  isCustom: true,
  config: {},
  configFields: [],
  props: [],
  template: ''
}

const CREDENTIAL_WITH_ORIGINS = {
  id: 'cred_7f3a91c2',
  siteId: 'site-1',
  name: 'Weather API',
  allowedOrigins: ['https://wiki.internal', 'https://status.internal'],
  createdAt: '',
  updatedAt: ''
}

const CREDENTIAL_WITHOUT_ORIGINS = {
  id: 'cred_20b84de1',
  siteId: 'site-1',
  name: 'Fleet telemetry',
  allowedOrigins: [],
  createdAt: '',
  updatedAt: ''
}

describe('AdminBlocks: Cardinal design conformance (Task #2629)', () => {
  it('draws the self-hosted server note as the informational banner -- a hairline box on the tint', async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK])

    const classes = wrapper.findComponent(WBanner).classes()

    expect(classes).toContain('border-hairline')
    expect(classes).toContain('bg-tint')
    expect(classes).toContain('text-slate')
    expect(classes).not.toContain('bg-grey-2')
    expect(classes).not.toContain('text-grey-7')
  })

  it("sets a block's tag in mono on the accent wash, not in the caption face on a Material pink", async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK])

    const tagChip = wrapper
      .findAllComponents(WChip)
      .find((chip) => chip.text().includes('<block-kroki>'))
    expect(tagChip).toBeTruthy()

    expect(tagChip.classes()).toContain('font-mono')
    expect(tagChip.attributes('style')).toContain('var(--color-accent-wash)')
    expect(tagChip.attributes('style')).toContain('var(--color-accent)')
    expect(tagChip.attributes('style')).not.toContain('var(--color-pink-1)')
  })

  it("marks a built-in block with --color-positive and a custom one with the design's own purple", async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK, CUSTOM_BLOCK])

    const builtin = wrapper.findAll('em').find((el) => el.text() === 'admin.blocks.builtin')
    const custom = wrapper.findAll('em').find((el) => el.text() === 'admin.blocks.custom')

    expect(builtin.classes()).toContain('text-positive')
    expect(builtin.classes()).not.toContain('text-teal-7')
    expect(custom.classes()).toContain('block-origin--custom')
    expect(custom.classes()).not.toContain('text-purple')
  })

  it('reads the word "Enabled" before the switch, as this screen draws it', async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK])

    const toggle = wrapper.find('.w-toggle')
    expect(toggle.exists()).toBe(true)

    const row = toggle.element.parentElement
    expect(row.firstElementChild.tagName).toBe('SPAN')
    expect(row.firstElementChild.textContent.trim()).toBe('admin.blocks.isEnabled')
    expect(row.lastElementChild.classList.contains('w-toggle')).toBe(true)

    // -> The visible label sits outside the switch, so the switch carries the accessible name
    expect(toggle.attributes('aria-label')).toBe('admin.blocks.isEnabled')
  })

  it('sets the credentials sub-heading in the display face rather than the Material h6 step', async () => {
    const wrapper = await mountAdminBlocks([], [CREDENTIAL_WITH_ORIGINS])

    const heading = wrapper.find('.admin-subsection-title')
    expect(heading.exists()).toBe(true)
    expect(heading.text()).toBe('admin.blocks.credentialsTitle')
    expect(heading.classes()).not.toContain('text-h6')
  })

  it("sets a credential's id in mono on the plain tint, and its copy target as a square", async () => {
    const wrapper = await mountAdminBlocks([], [CREDENTIAL_WITH_ORIGINS])

    const idChip = wrapper
      .findAllComponents(WChip)
      .find((chip) => chip.text().includes('cred_7f3a91c2'))
    expect(idChip).toBeTruthy()
    expect(idChip.classes()).toContain('font-mono')
    expect(idChip.attributes('style')).toContain('var(--color-tint)')
    expect(idChip.attributes('style')).toContain('var(--color-slate)')

    const copyBtn = wrapper.find('[aria-label="admin.blocks.credentialCopyId"]')
    expect(copyBtn.exists()).toBe(true)
    expect(copyBtn.classes()).not.toContain('rounded-full')
    // -> This button asks for neither `round` nor `rounded`, so it takes `WBtn`'s default corner,
    //    the `--radius-control` token.
    expect(copyBtn.classes()).toContain('rounded-control')
  })

  it('sets the allowed origins in mono, and turns the globe accent alongside the message when there are none', async () => {
    const wrapper = await mountAdminBlocks(
      [],
      [CREDENTIAL_WITH_ORIGINS, CREDENTIAL_WITHOUT_ORIGINS]
    )

    const globes = wrapper
      .findAll('.w-icon')
      .filter((icon) => icon.attributes('style')?.includes('13px'))
    expect(globes).toHaveLength(2)

    expect(globes[0].classes()).toContain('text-slate-soft')
    // -> No origins means an unusable credential, so the glyph reddens with the line
    expect(globes[1].classes()).toContain('text-negative')

    // -> `span.font-mono` rather than any span: `WItemLabel` renders a span of its own around this
    //    one, and it is the inner one that has to carry the face
    const originsLine = wrapper
      .findAll('span.font-mono')
      .find((el) => el.text() === 'https://wiki.internal, https://status.internal')
    expect(originsLine).toBeTruthy()
  })

  it('paints the credentials empty state in the Cardinal secondary tier, not the Material grey', async () => {
    const wrapper = await mountAdminBlocks([], [])

    const empty = wrapper
      .findAll('div')
      .find((el) => el.text() === 'admin.blocks.credentialsEmpty' && el.classes().includes('p-4'))
    expect(empty).toBeTruthy()
    expect(empty.classes()).toContain('text-text-secondary')
    expect(empty.classes()).not.toContain('text-grey')
  })

  it("leaves no Material blue-grey on any of the list's outlined actions", async () => {
    const wrapper = await mountAdminBlocks([KROKI_BLOCK], [CREDENTIAL_WITH_ORIGINS])

    const outlined = wrapper
      .findAllComponents(WBtn)
      .filter((btn) => btn.props('outline'))
      .map((btn) => btn.props('color'))

    expect(outlined.length).toBeGreaterThan(0)
    for (const color of outlined) {
      expect(color).not.toMatch(/^blue-grey/)
    }
    expect(outlined).toContain('slate')
  })
})
