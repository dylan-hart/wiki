import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminAuth from './AdminAuth.vue'

/**
 * Regression coverage for Task 441: the "Add Strategy" picker's `availableStrategies` list is a flat,
 * unfiltered `<w-list>` -- fine for the 4 built-in modules, unworkable once Feature 355 adds a dozen
 * branded presets. This locks in the text filter (narrows by `str.title`, case-insensitive substring,
 * the same pattern `AdminIcons.vue`'s icon-set search uses) and the icon/logo/color wiring for each
 * new preset in both the picker and the configured-strategy list.
 */

const MESSAGES = {
  en: {
    admin: {
      auth: {
        addStrategy: 'Add Strategy',
        filterModules: 'Filter modules...',
        noModulesToAdd: 'No other authentication module is installed on this server.',
        noModulesMatchFilter: 'No installed module matches your filter.',
        selfRegistration: 'Self-Registration',
        selfRegistrationHint: 'form-based hint',
        selfRegistrationLocalHint: 'local hint',
        autoProvisioning: 'Auto-Provisioning',
        autoProvisioningHint: 'redirect-based hint'
      }
    }
  }
}

/** The generic modules plus every branded preset Feature 355 is adding -- 12 entries total. */
const MODULES = [
  {
    key: 'local',
    title: 'Local',
    icon: 'ultraviolet-local.svg',
    description: 'Built-in.',
    useForm: true
  },
  {
    key: 'oidc',
    title: 'Generic OIDC',
    icon: 'ultraviolet-oidc.svg',
    description: 'Generic OIDC.',
    useForm: false
  },
  {
    key: 'oauth2',
    title: 'Generic OAuth2',
    icon: 'ultraviolet-oauth2.svg',
    description: 'Generic OAuth2.',
    useForm: false
  },
  {
    key: 'auth0',
    title: 'Auth0',
    icon: 'ultraviolet-auth0.svg',
    description: 'Auth0 OIDC.',
    useForm: false
  },
  {
    key: 'okta',
    title: 'Okta',
    icon: 'ultraviolet-okta.svg',
    description: 'Okta OIDC.',
    useForm: false
  },
  {
    key: 'microsoft',
    title: 'Microsoft',
    icon: 'ultraviolet-microsoft.svg',
    description: 'Microsoft Entra ID.',
    useForm: false
  },
  {
    key: 'keycloak',
    title: 'Keycloak',
    icon: 'ultraviolet-keycloak.svg',
    description: 'Self-hosted Keycloak.',
    useForm: false
  },
  {
    key: 'gitlab',
    title: 'GitLab',
    icon: 'ultraviolet-gitlab.svg',
    description: 'GitLab OIDC.',
    useForm: false
  },
  {
    key: 'twitch',
    title: 'Twitch',
    icon: 'ultraviolet-twitch.svg',
    description: 'Twitch OIDC.',
    useForm: false
  },
  {
    key: 'discord',
    title: 'Discord',
    icon: 'ultraviolet-discord.svg',
    description: 'Discord.',
    useForm: false
  },
  {
    key: 'slack',
    title: 'Slack',
    icon: 'ultraviolet-slack.svg',
    description: 'Slack OIDC.',
    useForm: false
  },
  {
    key: 'github',
    title: 'GitHub',
    icon: 'ultraviolet-github.svg',
    description: 'GitHub.',
    useForm: false
  }
]

async function mountPage({ strategies = [] } = {}) {
  setActivePinia(createPinia())

  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'authentication/modules') {
      return { json: () => Promise.resolve(MODULES) }
    }
    if (url === 'authentication/strategies') {
      return { json: () => Promise.resolve(strategies) }
    }
    if (url === 'groups') {
      return { json: () => Promise.resolve([]) }
    }
    return { json: () => Promise.resolve(undefined) }
  })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: MESSAGES })

  const wrapper = mount(AdminAuth, {
    attachTo: document.body,
    global: { plugins: [i18n] }
  })
  await flushPromises()

  return wrapper
}

/** Opens the "Add Strategy" menu by clicking its trigger button, and waits for it to render. */
async function openAddStrategyMenu(wrapper) {
  const trigger = wrapper.findAll('button').find((btn) => btn.text().includes('Add Strategy'))
  await trigger.trigger('click')
  await flushPromises()
}

function menuItemTitles() {
  return [...document.querySelectorAll('[role="menu"] strong')].map((el) => el.textContent.trim())
}

/*
  Teleported menu content lives outside the mounted wrapper's own DOM subtree (WMenu.vue teleports to
  `document.body`), so a test that throws before its own `wrapper.unmount()` would otherwise leave
  its menu panel behind for the next test's `document.querySelector('[role="menu"] ...')` to
  accidentally pick up alongside the new one -- this clears the slate unconditionally either way.
*/
afterEach(() => {
  document.body.innerHTML = ''
})

describe('AdminAuth add-strategy picker', () => {
  it('lists every non-local module before any filter text is entered', async () => {
    const wrapper = await mountPage()
    await openAddStrategyMenu(wrapper)

    const titles = menuItemTitles()
    // -> 12 modules minus the built-in `local` one, which is filtered out (already configured)
    expect(titles).toHaveLength(11)
    expect(titles).toContain('Auth0')
    expect(titles).toContain('Discord')
    expect(titles).not.toContain('Local')

    wrapper.unmount()
  })

  it('narrows the list to a case-insensitive substring match against the module title', async () => {
    const wrapper = await mountPage()
    await openAddStrategyMenu(wrapper)

    const filterInput = document.querySelector('[role="menu"] input')
    expect(filterInput).toBeTruthy()

    filterInput.value = 'auth0'
    await filterInput.dispatchEvent(new Event('input'))
    await flushPromises()

    // -> Case-insensitive: lowercase "auth0" still matches the title "Auth0"
    expect(menuItemTitles()).toEqual(['Auth0'])

    wrapper.unmount()
  })

  it('shows every module again once the filter is cleared', async () => {
    const wrapper = await mountPage()
    await openAddStrategyMenu(wrapper)

    const filterInput = document.querySelector('[role="menu"] input')
    filterInput.value = 'slack'
    await filterInput.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(menuItemTitles()).toEqual(['Slack'])

    filterInput.value = ''
    await filterInput.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(menuItemTitles()).toHaveLength(11)

    wrapper.unmount()
  })

  it('resets the filter text each time the menu is reopened', async () => {
    const wrapper = await mountPage()
    await openAddStrategyMenu(wrapper)

    const filterInput = document.querySelector('[role="menu"] input')
    filterInput.value = 'okta'
    await filterInput.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(menuItemTitles()).toEqual(['Okta'])

    // -> Close (click the trigger again) and reopen
    const trigger = wrapper.findAll('button').find((btn) => btn.text().includes('Add Strategy'))
    await trigger.trigger('click')
    await flushPromises()
    await trigger.trigger('click')
    await flushPromises()

    expect(menuItemTitles()).toHaveLength(11)

    wrapper.unmount()
  })

  it("renders every preset with a resolvable icon, avoiding a blank/typo'd avatar", async () => {
    const wrapper = await mountPage()
    await openAddStrategyMenu(wrapper)

    // -> `w-icon` renders an `img:` reference as `<i class="w-icon" data-icon="img:...">` wrapping
    //    an `<img>` (WIcon.vue), not `<iconify-icon>` -- that branch is only for a bare
    //    `<prefix>:<name>` Iconify reference, which `'img:' + str.icon` never is.
    const icons = [...document.querySelectorAll('[role="menu"] .w-avatar .w-icon')]
    // -> One resolvable icon reference per listed module (11, `local` excluded)
    expect(icons).toHaveLength(11)
    for (const icon of icons) {
      expect(icon.dataset.icon).toMatch(/^img:.+\.svg$/)
      const img = icon.querySelector('img')
      expect(img?.getAttribute('src')).toBe(icon.dataset.icon.slice(4))
    }

    wrapper.unmount()
  })
})

/**
 * Coverage for Task 2136: the strategy editor's single registration toggle is now labelled for what
 * it actually does per module -- self-registration through the wiki's own form for a form-based
 * module (`useForm: true`, e.g. local), auto-provisioning from the identity provider for a redirect
 * module (`useForm: false`, e.g. every OAuth2/OIDC/SAML preset) -- and the
 * `admin.auth.registrationNotEnforced` caption is gone.
 */
describe('AdminAuth registration control', () => {
  it('labels the toggle for self-registration on a form-based module, using its local-specific hint', async () => {
    const wrapper = await mountPage({
      strategies: [
        {
          id: 's-local',
          module: 'local',
          displayName: 'Local login',
          isEnabled: true,
          isNew: false,
          registration: false
        }
      ]
    })

    expect(wrapper.text()).toContain('Self-Registration')
    expect(wrapper.text()).toContain('local hint')
    expect(wrapper.text()).not.toContain('Auto-Provisioning')

    wrapper.unmount()
  })

  it('labels the toggle for auto-provisioning on a redirect module', async () => {
    const wrapper = await mountPage({
      strategies: [
        {
          id: 's-auth0',
          module: 'auth0',
          displayName: 'Auth0 login',
          isEnabled: true,
          isNew: false,
          registration: false
        }
      ]
    })

    expect(wrapper.text()).toContain('Auto-Provisioning')
    expect(wrapper.text()).toContain('redirect-based hint')
    expect(wrapper.text()).not.toContain('Self-Registration')

    wrapper.unmount()
  })

  it('never renders the deleted "not enforced" caption for either module kind', async () => {
    const wrapper = await mountPage({
      strategies: [
        {
          id: 's-local',
          module: 'local',
          displayName: 'Local login',
          isEnabled: true,
          isNew: false,
          registration: true
        }
      ]
    })

    expect(wrapper.text()).not.toContain('not enforced')

    wrapper.unmount()
  })
})

describe('AdminAuth configured-strategy list', () => {
  it("renders each active strategy's icon from its resolved module, keyed by module key", async () => {
    const activeStrategies = [
      {
        id: 's-auth0',
        module: 'auth0',
        displayName: 'Auth0 login',
        isEnabled: true,
        isNew: false
      },
      {
        id: 's-discord',
        module: 'discord',
        displayName: 'Discord login',
        isEnabled: false,
        isNew: false
      }
    ]
    const wrapper = await mountPage({ strategies: activeStrategies })

    const rows = wrapper.findAll('.w-list .w-item')
    expect(rows.length).toBeGreaterThanOrEqual(2)

    const auth0Icon = wrapper.find('.w-list .w-icon[data-icon="img:ultraviolet-auth0.svg"]')
    const discordIcon = wrapper.find('.w-list .w-icon[data-icon="img:ultraviolet-discord.svg"]')
    expect(auth0Icon.exists()).toBe(true)
    expect(discordIcon.exists()).toBe(true)

    wrapper.unmount()
  })
})
