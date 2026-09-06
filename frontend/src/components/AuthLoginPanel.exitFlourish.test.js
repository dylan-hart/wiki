import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AuthLoginPanel from './AuthLoginPanel.vue'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2747/#2750 ("Login exit flourish"): on a successful login, `handleLoginResponse()`'s
 * `redirect` case now sets the `cardinal:justLoggedIn` sessionStorage flag `MainLayout.vue` (task
 * #2751) reads-and-clears on mount, and -- unless `prefers-reduced-motion` is set -- emits
 * `exit-flourish` (which `Login.vue` turns into the `.auth-content`/`.auth-bg` exit animation) before
 * delaying the hard navigation by that animation's ~320ms budget.
 */

const JUST_LOGGED_IN_KEY = 'cardinal:justLoggedIn'

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

async function loginAndRespond(resp) {
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })

  const { wrapper } = mountWithApp(AuthLoginPanel, { stores: { site: { id: 'site-1' } } })
  await flushPromises()

  const inputs = wrapper.findAll('input')
  await inputs[0].setValue('reader@example.com')
  await inputs[1].setValue('correct horse battery staple')

  API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve(resp) })
  await wrapper.find('form').trigger('submit')
  await flushPromises()

  return wrapper
}

describe('AuthLoginPanel exit flourish', () => {
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

  describe('without prefers-reduced-motion', () => {
    beforeEach(() => {
      matchMediaSpy = stubReducedMotion(false)
    })

    it('sets the sessionStorage flag before the delayed navigation fires', async () => {
      await loginAndRespond({
        ok: true,
        nextAction: 'redirect',
        redirect: '/dashboard',
        continuationToken: ''
      })

      // -> The flag is set synchronously, well before the animation budget elapses.
      expect(sessionStorage.getItem(JUST_LOGGED_IN_KEY)).toBe('1')
      expect(replaceSpy).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(320)
      expect(replaceSpy).toHaveBeenCalledWith('/dashboard')
    })

    it('emits exit-flourish before the navigation delay elapses', async () => {
      const wrapper = await loginAndRespond({
        ok: true,
        nextAction: 'redirect',
        redirect: '/dashboard',
        continuationToken: ''
      })

      expect(wrapper.emitted('exit-flourish')).toBeTruthy()
      expect(replaceSpy).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(320)
      expect(replaceSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('with prefers-reduced-motion', () => {
    beforeEach(() => {
      matchMediaSpy = stubReducedMotion(true)
    })

    it('sets the flag and navigates immediately, skipping the exit-animation code path entirely', async () => {
      const wrapper = await loginAndRespond({
        ok: true,
        nextAction: 'redirect',
        redirect: '/dashboard',
        continuationToken: ''
      })

      expect(sessionStorage.getItem(JUST_LOGGED_IN_KEY)).toBe('1')
      expect(replaceSpy).toHaveBeenCalledWith('/dashboard')
      expect(wrapper.emitted('exit-flourish')).toBeFalsy()
    })
  })
})
