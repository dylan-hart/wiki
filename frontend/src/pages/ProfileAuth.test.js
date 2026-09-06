import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import ProfileAuth from './ProfileAuth.vue'

import { createTestI18n } from '../../test/i18n.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * OpenProject #1874: `GET /users/profile/tfa/recovery-codes` (`backend/api/users/profile.ts`) was a
 * finished, tested route with no caller -- `ProfileAuth.vue` only ever POSTed the same path to
 * regenerate. This locks in the fetch-and-display: the count is pulled once the auth methods load,
 * only for a local-strategy method with 2FA active, and rendered as an "N of M remaining" line with
 * a visibly distinct nudge once the remaining ratio drops to the low-count threshold.
 */

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

/** A single local auth method, 2FA active by default -- override `config` to vary it. */
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
    // -> The rest of the auth method row still rendered fine
    expect(wrapper.text()).toContain('Local')
  })
})

/**
 * OpenProject #2701 -- the section on the settings pattern. Two cards (the auth methods, the
 * passkeys), a row per entry, the provider's own logo on the plate rather than a generic glyph, and
 * everything the row has to say about itself -- the password-login state, the recovery-code count --
 * in the one hint column under the label instead of in two separate side sections.
 */
describe('ProfileAuth on the settings pattern', () => {
  it('draws the auth methods as settings rows, each plated with its own provider logo', async () => {
    const wrapper = await mountPage({
      authMethods: [localAuthMethod({ isTfaSetup: false })],
      recoveryCodesResponse: { ok: true, total: 10, remaining: 10 }
    })

    const rows = wrapper.findAll('.w-settings-row')
    // -> One auth method; `mountPage` stubs no passkeys, and the passkeys card is only drawn when
    //    there is one to put in it
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
