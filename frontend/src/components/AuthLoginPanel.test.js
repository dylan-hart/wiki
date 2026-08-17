import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AuthLoginPanel from './AuthLoginPanel.vue'
import { useSiteStore } from '@/stores/site'
import { queue as notifyQueue } from '@/composables/notify'

/**
 * `register()` used to be a dead `APOLLO_CLIENT.mutate(...)` call (there is no GraphQL server left --
 * see CLAUDE.md's "GraphQL is being removed") that also never sent `strategyId`, which the REST route
 * requires. This covers the two shapes `POST sites/:siteId/auth/register` answers with: `nextAction:
 * 'verify'` (email validation on -- show the check-your-email screen rather than auto-logging in) and
 * any other `nextAction` (email validation off -- falls straight through to the same
 * `handleLoginResponse()` every other login path already uses, exercised here via `changePassword`
 * since it needs no real navigation to observe).
 */

const LOCAL_STRATEGY = {
  id: 'strategy-1',
  activeStrategy: {
    displayName: 'Local',
    registration: true,
    allowForgotPassword: true,
    strategy: {
      key: 'local',
      useForm: true,
      usernameType: 'email',
      icon: 'local.svg'
    }
  }
}

function mountAuthLoginPanel() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        auth: {
          registering: 'Creating account...',
          registerCheckEmail: 'Check your emails to activate your account.',
          verifySuccess: 'Your email address has been verified. You can now log in.',
          switchToRegister: { link: 'Create an Account' },
          changePwd: { instructions: 'You must choose a new password:' },
          errors: { register: 'One or more fields are invalid.' }
        }
      }
    }
  })

  const wrapper = mount(AuthLoginPanel, {
    global: {
      plugins: [i18n]
    }
  })

  return { wrapper, siteStore }
}

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
  window.history.replaceState(null, '', '/login')
})

describe('AuthLoginPanel register', () => {
  it('posts strategyId/name/email/password to the REST endpoint and shows the check-email screen on nextAction: verify', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, nextAction: 'verify' })
    })

    const { wrapper } = mountAuthLoginPanel()
    await vi.waitFor(() => expect(API_CLIENT.get).toHaveBeenCalled())
    await wrapper.vm.$nextTick()

    const switchBtn = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('Create an Account'))
    await switchBtn.trigger('click')
    await wrapper.vm.$nextTick()

    await wrapper.find('input[autocomplete="name"]').setValue('Ada Lovelace')
    await wrapper.find('input[autocomplete="email"]').setValue('ada@example.com')
    await wrapper.find('input[autocomplete="new-password"]').setValue('supersecret1')
    await wrapper.findAll('input[autocomplete="new-password"]')[1].setValue('supersecret1')

    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(API_CLIENT.post).toHaveBeenCalled())

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/auth/register', {
      json: {
        strategyId: 'strategy-1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'supersecret1'
      },
      throwHttpErrors: expect.any(Function)
    })

    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Check your emails to activate your account.')
  })

  it('routes through handleLoginResponse instead when nextAction is not verify', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })
    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ ok: true, nextAction: 'changePassword', continuationToken: 'tok-1' })
    })

    const { wrapper } = mountAuthLoginPanel()
    await vi.waitFor(() => expect(API_CLIENT.get).toHaveBeenCalled())
    await wrapper.vm.$nextTick()

    const switchBtn = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('Create an Account'))
    await switchBtn.trigger('click')
    await wrapper.vm.$nextTick()

    await wrapper.find('input[autocomplete="name"]').setValue('Ada Lovelace')
    await wrapper.find('input[autocomplete="email"]').setValue('ada@example.com')
    await wrapper.find('input[autocomplete="new-password"]').setValue('supersecret1')
    await wrapper.findAll('input[autocomplete="new-password"]')[1].setValue('supersecret1')

    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(API_CLIENT.post).toHaveBeenCalled())
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('You must choose a new password:')
    expect(wrapper.text()).not.toContain('Check your emails to activate your account.')
  })
})

describe('AuthLoginPanel verified landing', () => {
  it('shows a success toast for ?verified=true and strips the query param', async () => {
    window.history.replaceState(null, '', '/login?verified=true')
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })

    mountAuthLoginPanel()
    await vi.waitFor(() => expect(notifyQueue.length).toBeGreaterThan(0))

    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
    expect(notifyQueue.find((n) => n.type === 'positive')?.message).toBe(
      'Your email address has been verified. You can now log in.'
    )
    expect(window.location.search).toBe('')
  })

  it('shows nothing when there is no verified param', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })

    mountAuthLoginPanel()
    await vi.waitFor(() => expect(API_CLIENT.get).toHaveBeenCalled())

    expect(notifyQueue.length).toBe(0)
  })
})
