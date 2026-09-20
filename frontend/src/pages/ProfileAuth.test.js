import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import ProfileAuth from './ProfileAuth.vue'

import { createTestI18n } from '../../test/i18n.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'
import { pendingProfileSaves } from '@/composables/profileSaving'
import { dialog } from '@/composables/dialog'

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

async function mountPage({ authMethods, recoveryCodesResponse }) {
  stubApi({
    'users/profile/auth': { authMethods, passkeys: [] },
    'users/profile/tfa/recovery-codes': recoveryCodesResponse
  })

  const i18n = createTestI18n(MESSAGES)
  const wrapper = mount(ProfileAuth, {
    global: { plugins: [i18n] }
  })
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

    const i18n = createTestI18n(MESSAGES)
    const wrapper = mount(ProfileAuth, { global: { plugins: [i18n] } })
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
