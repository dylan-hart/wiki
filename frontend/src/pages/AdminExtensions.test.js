import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminExtensions from './AdminExtensions.vue'

/**
 * Task 661: the extensions list now surfaces two things `AdminExtensions.vue` used to only learn from
 * a one-shot install-response toast.
 *
 * - `needsRestart` (computed server-side from `extensions.hasLoadFailed()` on every `getExtensions()`
 *   call) must show a persistent warning badge on the row, independent of whether the admin touched
 *   the install button this session at all — e.g. a module that failed to load during a page render.
 * - `incompatibleReason` must be surfaced as a tooltip on the disabled "not compatible" button, naming
 *   what this server actually reports.
 *
 * `WTooltip` is stubbed to a plain pass-through: it only renders its slot into the DOM on hover
 * (teleported to `<body>`, gated on a timer-delayed `shown` ref — see its own file), which is real
 * behavior worth trusting rather than re-driving here. Stubbing it turns this into a test of what
 * `AdminExtensions.vue` PASSES to the tooltip, which is what this task actually changed.
 */
const messages = {
  en: {
    'admin.extensions.needsRestart':
      'This extension failed to load and needs the server restarted before it can be used.',
    'admin.extensions.incompatible': 'not compatible',
    'admin.extensions.installed': 'Installed',
    'admin.extensions.install': 'Install',
    'admin.extensions.reinstall': 'Reinstall',
    'admin.extensions.instructions': 'Instructions',
    'admin.extensions.instructionsHint': 'Must be installed manually',
    'admin.extensions.title': 'Extensions',
    'admin.extensions.subtitle': 'Install extensions for extra functionality',
    'common.actions.viewDocs': 'View docs',
    'common.actions.refresh': 'Refresh'
  }
}

async function mountWithExtensions(extensions) {
  setActivePinia(createPinia())

  globalThis.API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(extensions) })

  const i18n = createI18n({ legacy: false, locale: 'en', messages })

  const wrapper = mount(AdminExtensions, {
    global: {
      plugins: [i18n],
      stubs: {
        BlueprintIcon: true,
        WTooltip: { template: '<div class="stub-tooltip"><slot /></div>' }
      }
    }
  })

  await flushPromises()
  return wrapper
}

describe('AdminExtensions needsRestart badge', () => {
  it('shows a persistent warning badge when needsRestart is true, unrelated to any install click', async () => {
    const wrapper = await mountWithExtensions([
      {
        key: 'sharp',
        title: 'Sharp',
        description: 'Image processing',
        website: '',
        isInstalled: true,
        isInstallable: true,
        isCompatible: true,
        incompatibleReason: null,
        needsRestart: true
      }
    ])

    const badgeIcon = wrapper.find('[data-icon="la:exclamation-triangle"]')
    expect(badgeIcon.exists()).toBe(true)
    expect(wrapper.text()).toContain('needs the server restarted before it can be used')
  })

  it('shows no warning badge when needsRestart is false', async () => {
    const wrapper = await mountWithExtensions([
      {
        key: 'sharp',
        title: 'Sharp',
        description: 'Image processing',
        website: '',
        isInstalled: true,
        isInstallable: true,
        isCompatible: true,
        incompatibleReason: null,
        needsRestart: false
      }
    ])

    expect(wrapper.find('[data-icon="la:exclamation-triangle"]').exists()).toBe(false)
  })
})

describe('AdminExtensions incompatible button tooltip', () => {
  it('names the required architecture/platform versus what this server reports', async () => {
    const wrapper = await mountWithExtensions([
      {
        key: 'weird-ext',
        title: 'Weird Extension',
        description: 'Needs an architecture this server does not have',
        website: '',
        isInstalled: false,
        isInstallable: false,
        isCompatible: false,
        incompatibleReason: 'requires architecture arm64, but this server is running x64',
        needsRestart: false
      }
    ])

    expect(wrapper.text()).toContain('requires architecture arm64, but this server is running x64')
  })
})
