import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import ProfileAuth from './ProfileAuth.vue'

import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'
import { pendingProfileSaves } from '@/composables/profileSaving'
import { confirm, dialog } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

/*
  The write-action tests need `confirm(...).onOk(cb)` to fire its callback immediately rather than
  wait on a rendered WConfirmDialog. No other test here clicks into a menu item that reaches
  `confirm()`/`dialog()`, so mocking both file-wide is safe.
*/
vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  confirm: vi.fn(() => ({ onOk: (cb) => cb() })),
  dialog: vi.fn(() => ({ onOk: () => ({ onCancel: () => {} }) }))
}))

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startRegistration: vi.fn(() => Promise.resolve({ id: 'cred-1' }))
}))

const MESSAGES = {
  profile: {
    auth: 'Login',
    authInfo: 'Your account is associated with the following authentication methods:',
    authActions: 'Actions',
    authTfaActive: 'Two-factor authentication is enabled on this account.',
    authTfaBadge: '2FA',
    authChangePassword: 'Change Password',
    authDisableTfa: 'Disable 2FA',
    authSetTfa: 'Set Up 2FA',
    authDisablePasswordLogin: 'Disable Password Login',
    authEnablePasswordLogin: 'Enable Password Login',
    authLoadingFailed: 'Failed to load',
    passkeys: 'Passkeys',
    passkeysIntro: 'Passkeys registered on this account:',
    passkeysAdd: 'Add Passkey',
    passkeysDeactivateConfirm: 'Remove this passkey?',
    tfaRecoveryCodesRegenerate: 'Regenerate Recovery Codes',
    tfaRecoveryCodesRemaining: '{remaining} of {total} recovery codes remaining',
    tfaRecoveryCodesLow:
      "You're running low on recovery codes — regenerate them soon so you don't get locked out."
  },
  common: {
    actions: {
      confirm: 'Confirm',
      delete: 'Delete'
    }
  }
}

function localAuthMethod(config = {}) {
  return {
    authId: 'auth-local',
    authName: 'Local',
    strategyKey: 'local',
    strategyIcon: 'ultraviolet-local.svg',
    config: {
      isPasswordSet: true,
      isTfaSetup: true,
      isTfaRequired: false,
      isPasswordLoginEnabled: true,
      canDisablePasswordLogin: true,
      ...config
    }
  }
}

async function mountPage({ authMethods, recoveryCodesResponse, passkeys = [], passkeysEnabled }) {
  stubApi({
    'users/profile/auth': { authMethods, passkeys, passkeysEnabled },
    'users/profile/tfa/recovery-codes': recoveryCodesResponse
  })

  const { wrapper } = mountWithApp(ProfileAuth, { messages: MESSAGES })
  await flushPromises()
  return wrapper
}

/**
 * `pendingProfileSaves` is the shared module singleton gating the Profile dialog's close button, so
 * every write action has to count itself on it. Each test hands the relevant `API_CLIENT` method a
 * manually-resolved promise, which is what makes the in-flight count observable at all.
 */
describe('ProfileAuth pendingProfileSaves (OpenProject #3282)', () => {
  beforeEach(() => {
    pendingProfileSaves.value = 0
  })

  it('counts disableTfa while the DELETE is in flight', async () => {
    const wrapper = await mountPage({
      authMethods: [localAuthMethod()],
      recoveryCodesResponse: { ok: true, total: 10, remaining: 10 }
    })
    let resolveDelete
    API_CLIENT.delete.mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve
      })
    )

    // -> `disableTfa()` returns nothing: its async work runs inside `confirm()`'s mocked `onOk`
    //    callback, so `flushPromises()` is the only handle on the in-flight and settled states.
    wrapper.vm.disableTfa('auth-local')
    await flushPromises()
    expect(pendingProfileSaves.value).toBe(1)

    resolveDelete({})
    await flushPromises()
    expect(pendingProfileSaves.value).toBe(0)
  })

  it('counts setPasswordLogin while the PUT is in flight', async () => {
    const wrapper = await mountPage({
      authMethods: [localAuthMethod()],
      recoveryCodesResponse: { ok: true, total: 10, remaining: 10 }
    })
    let resolvePut
    API_CLIENT.put.mockReturnValue({
      json: () =>
        new Promise((resolve) => {
          resolvePut = resolve
        })
    })

    const disableLoginPromise = wrapper.vm.setPasswordLogin('auth-local', false)
    await flushPromises()
    expect(pendingProfileSaves.value).toBe(1)

    resolvePut({})
    await disableLoginPromise
    expect(pendingProfileSaves.value).toBe(0)
  })

  it('counts regenerateRecoveryCodes while the POST is in flight', async () => {
    const wrapper = await mountPage({
      authMethods: [localAuthMethod()],
      recoveryCodesResponse: { ok: true, total: 10, remaining: 10 }
    })
    let resolvePost
    API_CLIENT.post.mockReturnValue({
      json: () =>
        new Promise((resolve) => {
          resolvePost = resolve
        })
    })

    wrapper.vm.regenerateRecoveryCodes('auth-local')
    await flushPromises()
    expect(pendingProfileSaves.value).toBe(1)

    resolvePost({ recoveryCodes: ['a', 'b'] })
    await flushPromises()
    expect(pendingProfileSaves.value).toBe(0)
  })

  it('counts deactivatePasskey while the DELETE is in flight', async () => {
    stubApi({
      'users/profile/auth': {
        authMethods: [],
        passkeys: [{ id: 'pk-1', name: 'Yubikey 5', siteHostname: 'wiki.example' }]
      }
    })
    const { wrapper } = mountWithApp(ProfileAuth, {
      messages: { ...MESSAGES, common: { ...MESSAGES.common, datetime: '{date} at {time}' } }
    })
    await flushPromises()
    let resolveDelete
    API_CLIENT.delete.mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve
      })
    )

    wrapper.vm.deactivatePasskey({ id: 'pk-1' })
    await flushPromises()
    expect(pendingProfileSaves.value).toBe(1)

    resolveDelete({})
    await flushPromises()
    expect(pendingProfileSaves.value).toBe(0)
  })

  it('counts setupPasskey across its challenge/register/verify round trip', async () => {
    const wrapper = await mountPage({
      authMethods: [localAuthMethod()],
      recoveryCodesResponse: { ok: true, total: 10, remaining: 10 }
    })
    dialog.mockImplementationOnce(() => ({
      onOk: (cb) => {
        cb({ name: 'My Passkey' })
        return { onCancel: () => {} }
      },
      onCancel: () => {}
    }))
    let resolveVerify
    API_CLIENT.post.mockImplementation((url) => {
      if (url === 'users/profile/passkeys/challenge') {
        return { json: () => Promise.resolve({ registrationOptions: {} }) }
      }
      if (url === 'users/profile/passkeys') {
        return {
          json: () =>
            new Promise((resolve) => {
              resolveVerify = resolve
            })
        }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const setupPromise = wrapper.vm.setupPasskey()
    await flushPromises()
    expect(pendingProfileSaves.value).toBe(1)

    resolveVerify({})
    await setupPromise
    expect(pendingProfileSaves.value).toBe(0)
  })
})

describe('ProfileAuth recovery-code count', () => {
  it('fetches and renders the remaining count for an enrolled local auth method', async () => {
    const wrapper = await mountPage({
      authMethods: [localAuthMethod()],
      recoveryCodesResponse: { ok: true, total: 10, remaining: 7 }
    })

    expect(API_CLIENT.get).toHaveBeenCalledWith('users/profile/tfa/recovery-codes', {
      searchParams: { strategyId: 'auth-local' }
    })
    expect(wrapper.text()).toContain('7 of 10 recovery codes remaining')
    // -> 7/10 is well above the low threshold, so no nudge
    expect(wrapper.text()).not.toContain('running low')
  })

  it('shows the low-count nudge once remaining drops to the threshold', async () => {
    const wrapper = await mountPage({
      authMethods: [localAuthMethod()],
      recoveryCodesResponse: { ok: true, total: 10, remaining: 2 }
    })

    expect(wrapper.text()).toContain('2 of 10 recovery codes remaining')
    expect(wrapper.text()).toContain('running low')
  })

  it('does not fetch or render a count when 2FA is not set up on the auth method', async () => {
    const wrapper = await mountPage({
      authMethods: [localAuthMethod({ isTfaSetup: false })],
      recoveryCodesResponse: { ok: true, total: 10, remaining: 10 }
    })

    expect(API_CLIENT.get).not.toHaveBeenCalledWith(
      'users/profile/tfa/recovery-codes',
      expect.anything()
    )
    expect(wrapper.text()).not.toContain('recovery codes remaining')
  })

  it('renders no count line when the status fetch fails, without disrupting the rest of the page', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'users/profile/auth') {
        return {
          json: () => Promise.resolve({ authMethods: [localAuthMethod()], passkeys: [] })
        }
      }
      if (url === 'users/profile/tfa/recovery-codes') {
        return { json: () => Promise.reject(new Error('400 Bad Request')) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const { wrapper } = mountWithApp(ProfileAuth, { messages: MESSAGES })
    await flushPromises()

    expect(wrapper.text()).not.toContain('recovery codes remaining')
    expect(wrapper.text()).toContain('Local')
  })
})

describe('ProfileAuth on the settings pattern', () => {
  it('draws the auth methods as settings rows, each plated with its own provider logo', async () => {
    const wrapper = await mountPage({
      authMethods: [localAuthMethod({ isTfaSetup: false })],
      recoveryCodesResponse: { ok: true, total: 10, remaining: 10 }
    })

    const rows = wrapper.findAll('.w-settings-row')
    // -> `mountPage` stubs no passkeys, and that card is only drawn when there is one to put in it.
    expect(rows).toHaveLength(1)
    expect(rows[0].find('.w-settings-row__label').text()).toBe('Local')
    expect(rows[0].find('.blueprint-icon img').attributes('src')).toBe('ultraviolet-local.svg')
    expect(wrapper.findAll('.w-settings-card')).toHaveLength(1)
  })

  it('puts the recovery-code count in the row hint rather than beside the control', async () => {
    const wrapper = await mountPage({
      authMethods: [localAuthMethod()],
      recoveryCodesResponse: { ok: true, total: 10, remaining: 2 }
    })

    const hint = wrapper.find('.w-settings-row .w-settings-row__hint')
    expect(hint.text()).toContain('2 of 10 recovery codes remaining')
    expect(hint.text()).toContain('running low')
    expect(wrapper.find('.w-settings-row__control').text()).not.toContain('recovery codes')
  })

  it('adds a passkeys card once there is a passkey, and keeps Add outside it either way', async () => {
    stubApi({
      'users/profile/auth': {
        authMethods: [localAuthMethod({ isTfaSetup: false })],
        passkeys: [
          {
            id: 'pk-1',
            name: 'Yubikey 5',
            siteHostname: 'wiki.example',
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      }
    })

    // -> `mountWithApp` rather than this file's own `mountPage`: a passkey row renders its created
    //    date through `humanizeDate()`, which reads `userStore` and so needs a Pinia instance.
    const { wrapper } = mountWithApp(ProfileAuth, {
      messages: { ...MESSAGES, common: { ...MESSAGES.common, datetime: '{date} at {time}' } }
    })
    await flushPromises()

    const cards = wrapper.findAll('.w-settings-card')
    expect(cards).toHaveLength(2)
    const passkeyRow = cards[1].find('.w-settings-row')
    expect(passkeyRow.find('.w-settings-row__label').text()).toBe('Yubikey 5')
    expect(passkeyRow.find('.w-settings-row__hint').text()).toContain('wiki.example')

    // -> The Add button is a page action, not a row: it has to be reachable when there is no card
    const addButton = wrapper.findAll('button').find((btn) => btn.text().includes('Add Passkey'))
    expect(addButton.element.closest('.w-settings-card')).toBeNull()
  })
})

/**
 * Tailwind's global stylesheet is never imported under Vitest, so a `getComputedStyle` assertion
 * cannot observe whether a `dark:` utility paints a different colour — only that the literal class
 * is present on the rendered icon.
 */
async function mountActionsMenu(config) {
  stubApi({
    'users/profile/auth': {
      authMethods: [localAuthMethod(config)],
      passkeys: []
    }
  })

  const { wrapper } = mountWithApp(ProfileAuth, { messages: MESSAGES })
  await flushPromises()

  // -> WMenu attaches its trigger listener to the enclosing button natively, so a plain click on
  //    it opens the (teleported-but-inline-stubbed) menu content.
  await wrapper.find('[aria-label="Actions"]').trigger('click')

  return wrapper
}

function expectBlueDarkPair(wrapper, iconName) {
  const icons = wrapper.findAll(`[data-icon="${iconName}"]`)
  expect(icons.length, iconName).toBeGreaterThan(0)
  for (const icon of icons) {
    expect(icon.classes(), iconName).toContain('text-blue-7')
    expect(icon.classes(), iconName).toContain('dark:text-blue-4')
  }
}

describe('ProfileAuth actions menu icons stay legible in dark mode (OpenProject #2741)', () => {
  it('pairs every text-blue-7 icon with dark:text-blue-4 (2FA enabled, password login enabled)', async () => {
    const wrapper = await mountActionsMenu()

    expectBlueDarkPair(wrapper, 'tabler:key')
    expectBlueDarkPair(wrapper, 'tabler:fingerprint')

    const banIcon = wrapper.find('[data-icon="tabler:ban"]')
    expect(banIcon.classes()).toContain('text-negative')
    expect(banIcon.classes()).toContain('dark:text-accent-dark')
  })

  it('pairs every text-blue-7 icon with dark:text-blue-4 (2FA disabled, password login disabled)', async () => {
    // -> A second mount, because these menu items and the ones above are v-if/v-else siblings that
    //    never render together.
    const wrapper = await mountActionsMenu({ isTfaSetup: false, isPasswordLoginEnabled: false })

    expectBlueDarkPair(wrapper, 'tabler:fingerprint')
    expectBlueDarkPair(wrapper, 'tabler:arrow-forward-up')
  })
})

describe('ProfileAuth admin policy toggles', () => {
  const PASSKEY = {
    id: 'pk-1',
    name: 'Laptop',
    siteHostname: 'wiki.example.com',
    createdAt: '2026-09-01T00:00:00.000Z'
  }

  function findButton(wrapper, label) {
    return wrapper.findAll('button').find((b) => b.text().includes(label))
  }

  it('shows the add-passkey button when passkeysEnabled is true', async () => {
    const wrapper = await mountPage({
      authMethods: [localAuthMethod()],
      passkeysEnabled: true
    })
    expect(findButton(wrapper, 'Add Passkey')).toBeTruthy()
  })

  it('shows the add-passkey button when the server does not report passkeysEnabled', async () => {
    const wrapper = await mountPage({ authMethods: [localAuthMethod()] })
    expect(findButton(wrapper, 'Add Passkey')).toBeTruthy()
  })

  it('hides the add-passkey button when passkeysEnabled is false, keeping stored passkeys listed and removable', async () => {
    const wrapper = await mountPage({
      authMethods: [localAuthMethod()],
      passkeys: [PASSKEY],
      passkeysEnabled: false
    })

    expect(findButton(wrapper, 'Add Passkey')).toBeUndefined()
    expect(wrapper.text()).toContain('Laptop')

    const removeButton = wrapper.find('button[aria-label="Delete"]')
    expect(removeButton.exists()).toBe(true)

    API_CLIENT.delete.mockReturnValue({ json: () => Promise.resolve({}) })
    await removeButton.trigger('click')
    await flushPromises()
    expect(API_CLIENT.delete).toHaveBeenCalledWith('users/profile/passkeys/pk-1')
  })

  it('shows the change-password item when canChangePassword is true or absent', async () => {
    const withFlag = await mountActionsMenu({ canChangePassword: true })
    expect(withFlag.text()).toContain('Change Password')

    const withoutFlag = await mountActionsMenu()
    expect(withoutFlag.text()).toContain('Change Password')
  })

  it('hides the change-password item when canChangePassword is false, keeping the other actions', async () => {
    const wrapper = await mountActionsMenu({ canChangePassword: false })
    expect(wrapper.text()).not.toContain('Change Password')
    expect(wrapper.text()).toContain('Disable 2FA')
  })
})

const LINK_MESSAGES = {
  ...MESSAGES,
  profile: {
    ...MESSAGES.profile,
    authConnect: 'Connect a Sign-in Method',
    authConnectInfo: 'Link another provider to your account.',
    authConnectWith: 'Connect {provider}',
    authDisconnect: 'Disconnect',
    authDisconnectConfirm: 'Disconnect {provider}?',
    authDisconnectSuccess: 'Sign-in method disconnected.',
    authDisconnectFailed: 'Failed to disconnect the sign-in method.',
    authDisconnectOnlyMethod: 'This is the only way to sign in to your account.'
  },
  error: {
    ERR_UNLINK_LAST_LOGIN_METHOD: 'This is the only way to sign in to the account.'
  }
}

const SITE_STRATEGIES = [
  {
    id: 'auth-local',
    activeStrategy: {
      displayName: 'Local',
      strategy: { key: 'local', icon: 'local.svg', useForm: true }
    }
  },
  {
    id: 'auth-oidc',
    activeStrategy: {
      displayName: 'Corp SSO',
      strategy: { key: 'oidc', icon: 'oidc.svg', useForm: false }
    }
  },
  {
    id: 'auth-github',
    activeStrategy: {
      displayName: 'GitHub',
      strategy: { key: 'github', icon: 'github.svg', useForm: false }
    }
  }
]

function providerAuthMethod(config = {}) {
  return {
    authId: 'auth-oidc',
    authName: 'Corp SSO',
    strategyKey: 'oidc',
    strategyIcon: 'oidc.svg',
    config: {
      isPasswordSet: false,
      isTfaSetup: false,
      isTfaRequired: false,
      isPasswordLoginEnabled: true,
      canChangePassword: true,
      canDisablePasswordLogin: true,
      canDisconnect: true,
      ...config
    }
  }
}

async function mountLinkPage({ authMethods, siteStrategies = SITE_STRATEGIES }) {
  const { calls } = stubApi({
    'users/profile/auth': { authMethods, passkeys: [] },
    'sites/site-1/auth/strategies': siteStrategies
  })
  const { wrapper } = mountWithApp(ProfileAuth, {
    messages: LINK_MESSAGES,
    stores: { site: { id: 'site-1' } }
  })
  await flushPromises()
  return { wrapper, calls }
}

function connectCard(wrapper) {
  return wrapper
    .findAll('.w-settings-card')
    .find((card) => card.text().includes('Connect a Sign-in Method'))
}

async function openProviderMenu(wrapper) {
  const row = wrapper
    .findAll('.w-settings-row')
    .find((r) => r.find('.w-settings-row__label').text() === 'Corp SSO')
  await row.find('[aria-label="Actions"]').trigger('click')
  return row
}

function disconnectItem(row) {
  return row.findAll('.w-item').find((i) => i.text().includes('Disconnect'))
}

describe('ProfileAuth connect a sign-in method', () => {
  it('offers only the enabled redirect-based strategies the account has not linked yet', async () => {
    const { wrapper, calls } = await mountLinkPage({
      authMethods: [localAuthMethod({ isTfaSetup: false }), providerAuthMethod()]
    })

    expect(calls).toContain('sites/site-1/auth/strategies')
    const card = connectCard(wrapper)
    expect(card).toBeTruthy()
    expect(card.findAll('.w-settings-row__label').map((l) => l.text())).toEqual(['GitHub'])
  })

  it('links each one to the link-mode authorize flow, returning to the current path', async () => {
    window.history.replaceState({}, '', '/en/some/page')
    const { wrapper } = await mountLinkPage({
      authMethods: [localAuthMethod({ isTfaSetup: false })]
    })

    const link = wrapper.find('a[aria-label="Connect GitHub"]')
    const url = new URL(link.attributes('href'), 'https://wiki.example')
    expect(url.pathname).toBe('/_api/auth/auth-github/authorize')
    expect(url.searchParams.get('mode')).toBe('link')
    expect(url.searchParams.get('siteId')).toBe('site-1')
    expect(url.searchParams.get('redirect')).toBe('/en/some/page')
    window.history.replaceState({}, '', '/')
  })

  it('returns to the root when the current path is longer than the redirect cap', async () => {
    window.history.replaceState({}, '', `/${'a'.repeat(300)}`)
    const { wrapper } = await mountLinkPage({
      authMethods: [localAuthMethod({ isTfaSetup: false })]
    })

    const link = wrapper.find('a[aria-label="Connect GitHub"]')
    const url = new URL(link.attributes('href'), 'https://wiki.example')
    expect(url.searchParams.get('redirect')).toBe('/')
    window.history.replaceState({}, '', '/')
  })

  it('draws no connect card once every redirect-based strategy is linked', async () => {
    const { wrapper } = await mountLinkPage({
      authMethods: [
        localAuthMethod({ isTfaSetup: false }),
        providerAuthMethod(),
        { ...providerAuthMethod(), authId: 'auth-github', authName: 'GitHub' }
      ]
    })
    expect(connectCard(wrapper)).toBeUndefined()
  })
})

describe('ProfileAuth disconnect a sign-in method', () => {
  beforeEach(() => {
    confirm.mockClear()
    pendingProfileSaves.value = 0
  })

  it('confirms, then deletes the linked provider and reloads the list', async () => {
    const { wrapper, calls } = await mountLinkPage({
      authMethods: [localAuthMethod({ isTfaSetup: false }), providerAuthMethod()]
    })
    API_CLIENT.delete.mockReturnValue(Promise.resolve({}))
    const row = await openProviderMenu(wrapper)
    const loadsBefore = calls.filter((u) => u === 'users/profile/auth').length

    await disconnectItem(row).trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Disconnect Corp SSO?',
        destructive: true,
        persistent: true
      })
    )
    expect(API_CLIENT.delete).toHaveBeenCalledWith('users/profile/auth/auth-oidc')
    expect(calls.filter((u) => u === 'users/profile/auth').length).toBe(loadsBefore + 1)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: 'Sign-in method disconnected.'
    })
    expect(pendingProfileSaves.value).toBe(0)
  })

  it('disables Disconnect, with the reason in the row, when it is the only way to sign in', async () => {
    const { wrapper } = await mountLinkPage({
      authMethods: [providerAuthMethod({ canDisconnect: false })]
    })
    const row = await openProviderMenu(wrapper)

    expect(row.find('.w-settings-row__hint').text()).toContain(
      'This is the only way to sign in to your account.'
    )
    const item = disconnectItem(row)
    expect(item.attributes('aria-disabled')).toBe('true')
    await item.trigger('click')
    await flushPromises()
    expect(confirm).not.toHaveBeenCalled()
    expect(API_CLIENT.delete).not.toHaveBeenCalled()
  })

  it('offers no Disconnect on the local row', async () => {
    const { wrapper } = await mountLinkPage({ authMethods: [localAuthMethod()] })
    await wrapper.find('[aria-label="Actions"]').trigger('click')
    expect(wrapper.text()).not.toContain('Disconnect')
  })

  it('reports a refused disconnect with the localized server error', async () => {
    const { wrapper } = await mountLinkPage({
      authMethods: [localAuthMethod({ isTfaSetup: false }), providerAuthMethod()]
    })
    const err = Object.assign(new Error('Bad Request'), {
      data: { message: 'ERR_UNLINK_LAST_LOGIN_METHOD' }
    })
    API_CLIENT.delete.mockReturnValue(Promise.reject(err))
    const row = await openProviderMenu(wrapper)

    await disconnectItem(row).trigger('click')
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Failed to disconnect the sign-in method.',
      caption: 'This is the only way to sign in to the account.'
    })
    expect(pendingProfileSaves.value).toBe(0)
  })
})
