import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import Login from './Login.vue'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2747/#2750 ("Login exit flourish"): `AuthLoginPanel`'s `exit-flourish` emit (fired on
 * a successful login, before its own delayed `window.location.replace()`) flips `Login.vue`'s
 * `auth--exiting` class, which is what plays the `.auth-content`/`.auth-bg` exit animation. This is a
 * full round trip through the real `AuthLoginPanel`, not a stub emitting the event directly, so it
 * proves the two components' sides of the contract actually meet.
 */

const MESSAGES = {
  auth: {
    login: { title: 'Login' },
    loginToContinue: 'Login to continue',
    loginSuccess: 'Signing you in…',
    selectAuthProvider: 'Sign in with',
    actions: { login: 'Log In' },
    fields: { email: 'Email Address', password: 'Password' },
    passkeys: { signin: 'Log In with a Passkey' }
  },
  common: {
    footerCopyright: '© {year} {company}. All rights reserved.',
    footerLicense: 'Content is available under the {license}, by {company}.',
    footerGeneric: 'Powered by {link}, an open source project.',
    footerPoweredBy: 'Powered by {link}',
    license: { alr: 'All Rights Reserved' }
  }
}

const LOCAL_STRATEGY = {
  id: 'strat-1',
  activeStrategy: {
    displayName: 'Local',
    registration: false,
    allowForgotPassword: false,
    strategy: {
      key: 'local',
      useForm: true,
      usernameType: 'email',
      icon: 'local.svg'
    }
  }
}

function stubReducedMotion(matches) {
  return vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
}

async function mountAndLogIn() {
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })

  const { wrapper } = mountWithApp(Login, {
    messages: MESSAGES,
    stores: { site: { id: 'site-1', title: 'Cardinal' } }
  })
  await flushPromises()

  const inputs = wrapper.findAll('input')
  await inputs[0].setValue('reader@example.com')
  await inputs[1].setValue('correct horse battery staple')

  API_CLIENT.put.mockReturnValueOnce({
    json: () =>
      Promise.resolve({
        ok: true,
        nextAction: 'redirect',
        redirect: '/dashboard',
        continuationToken: ''
      })
  })
  await wrapper.find('form').trigger('submit')
  await flushPromises()

  return wrapper
}

describe('Login exit flourish', () => {
  let replaceSpy
  let matchMediaSpy

  beforeEach(() => {
    vi.useFakeTimers()
    replaceSpy = vi.spyOn(window.location, 'replace').mockImplementation(() => {})
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    replaceSpy.mockRestore()
    matchMediaSpy?.mockRestore()
    sessionStorage.clear()
  })

  it('applies auth--exiting before the delayed navigation, then navigates', async () => {
    matchMediaSpy = stubReducedMotion(false)
    const wrapper = await mountAndLogIn()

    expect(wrapper.find('.auth').classes()).toContain('auth--exiting')
    expect(replaceSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(320)
    expect(replaceSpy).toHaveBeenCalledWith('/dashboard')
  })

  it('never applies auth--exiting under prefers-reduced-motion, navigating immediately instead', async () => {
    matchMediaSpy = stubReducedMotion(true)
    const wrapper = await mountAndLogIn()

    expect(wrapper.find('.auth').classes()).not.toContain('auth--exiting')
    expect(replaceSpy).toHaveBeenCalledWith('/dashboard')
  })
})
