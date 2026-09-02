import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AuthLoginPanel from './AuthLoginPanel.vue'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

/**
 * OpenProject #2208 §2/§9: `handleLoginResponse()`'s `nextAction: 'redirect'` case used to read a
 * `loginRedirect` cookie nothing in this app ever wrote, and passed whatever it (or the backend's own
 * `resp.redirect`, ultimately a group's `redirectOnLogin`) held straight to `window.location.replace()`
 * with no scheme check -- a `javascript:` value there executes in this origin, with no click required.
 * The cookie reads are gone (`isFollowableRedirectTarget()` guards what remains); this covers it.
 */

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

async function loginAndRespond(resp) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })

  const i18n = createTestI18n()
  const wrapper = mount(AuthLoginPanel, { global: { plugins: [i18n] } })
  await flushPromises()

  const inputs = wrapper.findAll('input')
  await inputs[0].setValue('reader@example.com')
  await inputs[1].setValue('correct horse battery staple')

  API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve(resp) })
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}

describe('AuthLoginPanel redirect handling', () => {
  let replaceSpy

  beforeEach(() => {
    vi.useFakeTimers()
    replaceSpy = vi.spyOn(window.location, 'replace').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    replaceSpy.mockRestore()
  })

  it('replaces location with a same-origin rooted redirect', async () => {
    await loginAndRespond({
      ok: true,
      nextAction: 'redirect',
      redirect: '/dashboard',
      continuationToken: ''
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(replaceSpy).toHaveBeenCalledWith('/dashboard')
  })

  it('replaces location with a complete https:// redirect', async () => {
    await loginAndRespond({
      ok: true,
      nextAction: 'redirect',
      redirect: 'https://elsewhere.example/x',
      continuationToken: ''
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(replaceSpy).toHaveBeenCalledWith('https://elsewhere.example/x')
  })

  it('refuses a javascript: redirect, falling back to /', async () => {
    await loginAndRespond({
      ok: true,
      nextAction: 'redirect',
      redirect: 'javascript:alert(1)',
      continuationToken: ''
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(replaceSpy).toHaveBeenCalledWith('/')
  })

  it('refuses a protocol-relative //host redirect, falling back to /', async () => {
    await loginAndRespond({
      ok: true,
      nextAction: 'redirect',
      redirect: '//evil.example',
      continuationToken: ''
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(replaceSpy).toHaveBeenCalledWith('/')
  })

  it('defaults to / when no redirect is given at all', async () => {
    await loginAndRespond({ ok: true, nextAction: 'redirect', continuationToken: '' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(replaceSpy).toHaveBeenCalledWith('/')
  })
})
