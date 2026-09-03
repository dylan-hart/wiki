import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AdminAuth from './AdminAuth.vue'

import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * Regression coverage for Task 441: the "Add Strategy" picker's `availableStrategies` list is a flat,
 * unfiltered `<w-list>` -- fine for the 4 built-in modules, unworkable once Feature 355 adds a dozen
 * branded presets. This locks in the text filter (narrows by `str.title`, case-insensitive substring,
 * the same pattern `AdminIcons.vue`'s icon-set search uses) and the icon/logo/color wiring for each
 * new preset in both the picker and the configured-strategy list.
 */

const MESSAGES = {
  admin: {
    auth: {
      addStrategy: 'Add Strategy',
      filterModules: 'Filter modules...',
      noModulesToAdd: 'No other authentication module is installed on this server.',
      noModulesMatchFilter: 'No installed module matches your filter.',
      mappableGroups: 'Mappable group(s)',
      mappableGroupsHint: 'Only a group selected here can ever be granted or revoked.',
      allowedEmailDomains: 'Allowed Email Domains',
      allowedEmailDomainsHint: 'Only allow self-registration from these domains.',
      allowedEmailDomainsPlaceholder: 'example.com'
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
  stubApi({
    'authentication/modules': MODULES,
    'authentication/strategies': strategies,
    groups: []
  })

  const { wrapper } = mountWithApp(AdminAuth, { attachTo: document.body, messages: MESSAGES })
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
  return [...document.querySelectorAll('.w-menu strong')].map((el) => el.textContent.trim())
}

/*
  Teleported menu content lives outside the mounted wrapper's own DOM subtree (WMenu.vue teleports to
  `document.body`), so a test that throws before its own `wrapper.unmount()` would otherwise leave
  its menu panel behind for the next test's `document.querySelector('.w-menu ...')` to
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

    const filterInput = document.querySelector('.w-menu input')
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

    const filterInput = document.querySelector('.w-menu input')
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

    const filterInput = document.querySelector('.w-menu input')
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
    const icons = [...document.querySelectorAll('.w-menu .w-avatar .w-icon')]
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
 * Task 2188: the `mappableGroups` allow-list picker. Gated on the module's own `mapGroups` config
 * prop, same as the module's own `groupsScope`/`groupSearchFilter`/... fields are gated in their
 * `definition.yml` -- shown only once group-mapping is actually turned on for this strategy, since
 * an allow-list means nothing to a strategy that never maps groups at all.
 */
describe('AdminAuth mappable-groups picker', () => {
  const LDAP_MODULE_WITH_MAP_GROUPS = {
    key: 'ldap',
    title: 'LDAP / AD',
    icon: 'ultraviolet-ldap.svg',
    description: 'LDAP.',
    props: {
      mapGroups: { type: 'boolean', title: 'Map Groups', default: false, hint: '', order: 1 }
    }
  }

  function mappablePickerNode(wrapper) {
    return wrapper.find('[aria-label="Mappable group(s)"]')
  }

  it('is not rendered when the strategy has not turned Map Groups on', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'authentication/modules') {
        return { json: () => Promise.resolve([LDAP_MODULE_WITH_MAP_GROUPS]) }
      }
      if (url === 'authentication/strategies') {
        return {
          json: () =>
            Promise.resolve([
              {
                id: 's-ldap',
                module: 'ldap',
                displayName: 'Directory login',
                isEnabled: true,
                isNew: false,
                config: { mapGroups: false },
                mappableGroups: []
              }
            ])
        }
      }
      if (url === 'groups') {
        return { json: () => Promise.resolve([{ id: 'g-editors', name: 'Editors' }]) }
      }
      return { json: () => Promise.resolve(undefined) }
    })
    const { wrapper } = mountWithApp(AdminAuth, { attachTo: document.body, messages: MESSAGES })
    await flushPromises()

    expect(mappablePickerNode(wrapper).exists()).toBe(false)

    wrapper.unmount()
  })

  it('renders, gated by Map Groups being on, with no selection when the allow-list is empty', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'authentication/modules') {
        return { json: () => Promise.resolve([LDAP_MODULE_WITH_MAP_GROUPS]) }
      }
      if (url === 'authentication/strategies') {
        return {
          json: () =>
            Promise.resolve([
              {
                id: 's-ldap',
                module: 'ldap',
                displayName: 'Directory login',
                isEnabled: true,
                isNew: false,
                config: { mapGroups: true },
                mappableGroups: []
              }
            ])
        }
      }
      if (url === 'groups') {
        return {
          json: () =>
            Promise.resolve([
              { id: 'g-editors', name: 'Editors' },
              { id: 'g-reviewers', name: 'Reviewers' }
            ])
        }
      }
      return { json: () => Promise.resolve(undefined) }
    })
    const { wrapper } = mountWithApp(AdminAuth, { attachTo: document.body, messages: MESSAGES })
    await flushPromises()

    const picker = mappablePickerNode(wrapper)
    expect(picker.exists()).toBe(true)
    // -> The `#selected` slot's empty-list branch renders a bare `<span>`, no selection caption
    expect(picker.text()).not.toContain('Editors')
    expect(picker.text()).not.toContain('Reviewers')

    wrapper.unmount()
  })
})

/**
 * OpenProject #2469: `allowedEmailDomains` is a per-strategy config field, a friendlier alternative to
 * `allowedEmailRegex` for the common case. Scoped like `selfRegistration` itself: shown only for a
 * form-based (`useForm`) module, never for a redirect-based provider's `autoProvision` half.
 */
describe('AdminAuth allowed-email-domains field', () => {
  const LOCAL_MODULE = {
    key: 'local',
    title: 'Local',
    icon: 'ultraviolet-local.svg',
    description: 'Built-in.',
    useForm: true
  }
  const OIDC_MODULE = {
    key: 'oidc',
    title: 'Generic OIDC',
    icon: 'ultraviolet-oidc.svg',
    description: 'Generic OIDC.',
    useForm: false
  }

  // -> `useInput` moves `aria-label` onto the `<input>` itself rather than a wrapping control (same
  //    distinction the project's own testing notes make for `WInput`), so this selects the input
  //    directly rather than a `w-select` container carrying the label.
  function domainsFieldNode(wrapper) {
    return wrapper.find('input[aria-label="Allowed Email Domains"]')
  }

  it('renders for a form-based strategy', async () => {
    stubApi({
      'authentication/modules': [LOCAL_MODULE],
      'authentication/strategies': [
        {
          id: 's-local',
          module: 'local',
          displayName: 'Local login',
          isEnabled: true,
          isNew: false,
          selfRegistration: true,
          config: {},
          allowedEmailDomains: []
        }
      ],
      groups: []
    })
    const { wrapper } = mountWithApp(AdminAuth, { attachTo: document.body, messages: MESSAGES })
    await flushPromises()

    expect(domainsFieldNode(wrapper).exists()).toBe(true)

    wrapper.unmount()
  })

  it('is not rendered for a redirect-based (autoProvision) strategy', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'authentication/modules') {
        return { json: () => Promise.resolve([OIDC_MODULE]) }
      }
      if (url === 'authentication/strategies') {
        return {
          json: () =>
            Promise.resolve([
              {
                id: 's-oidc',
                module: 'oidc',
                displayName: 'OIDC login',
                isEnabled: true,
                isNew: false,
                autoProvision: true,
                config: {},
                allowedEmailDomains: []
              }
            ])
        }
      }
      if (url === 'groups') {
        return { json: () => Promise.resolve([]) }
      }
      return { json: () => Promise.resolve(undefined) }
    })
    const { wrapper } = mountWithApp(AdminAuth, { attachTo: document.body, messages: MESSAGES })
    await flushPromises()

    expect(domainsFieldNode(wrapper).exists()).toBe(false)

    wrapper.unmount()
  })

  it('typing a domain and pressing Enter adds it, trimmed and lower-cased, with no duplicates', async () => {
    stubApi({
      'authentication/modules': [LOCAL_MODULE],
      'authentication/strategies': [
        {
          id: 's-local',
          module: 'local',
          displayName: 'Local login',
          isEnabled: true,
          isNew: false,
          selfRegistration: true,
          config: {},
          allowedEmailDomains: ['already.example']
        }
      ],
      groups: []
    })
    const { wrapper } = mountWithApp(AdminAuth, { attachTo: document.body, messages: MESSAGES })
    await flushPromises()

    const input = domainsFieldNode(wrapper)
    await input.trigger('focus')
    await input.setValue(' Example.COM ')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    // -> A duplicate, differently-cased entry must not create a second chip
    await input.trigger('focus')
    await input.setValue('already.example')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    // -> Nothing else on this screen renders a `w-chip` for this fixture (no other `use-chips`
    //    field has a selection, and the add-strategy menu is not open), so scoping to the whole
    //    page is safe here.
    expect(wrapper.text()).toContain('example.com')
    expect(wrapper.text()).toContain('already.example')
    expect(wrapper.findAll('.w-chip')).toHaveLength(2)

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
