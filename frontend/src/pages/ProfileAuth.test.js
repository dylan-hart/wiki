import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import ProfileAuth from './ProfileAuth.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * OpenProject #1874: `GET /users/profile/tfa/recovery-codes` (`backend/api/users.ts`) was a
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
  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'users/profile/auth') {
      return { json: () => Promise.resolve({ authMethods, passkeys: [] }) }
    }
    if (url === 'users/profile/tfa/recovery-codes') {
      return { json: () => Promise.resolve(recoveryCodesResponse) }
    }
    return { json: () => Promise.resolve(undefined) }
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
