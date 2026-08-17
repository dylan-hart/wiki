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
          switchToLogin: { link: 'Back to Login' },
          changePwd: { instructions: 'You must choose a new password:' },
          forgotPasswordLink: 'Forgot Password',
          forgotPasswordSubtitle: 'Enter your email address:',
          forgotPasswordSuccess: 'Check your emails for password reset instructions!',
          resetPassword: {
            subtitle: 'Choose a new password for your account:',
            success: 'Your password has been changed.'
          },
          tfa: { subtitle: 'Security code required:' },
          fields: { email: 'Email Address' },
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

/**
 * `forgotPassword()` used to be a stub (`// TODO: Implement forgot password`). The route it now calls
 * (`POST sites/:siteId/auth/forgotPassword`) always answers the same generic 200 whatever it did behind
 * the scenes -- see the route's own doc comment in `backend/api/authentication.ts` -- so this only
 * checks the request shape and that the UI shows the fixed success message, never that it branches on
 * the response.
 */
describe('AuthLoginPanel forgot password', () => {
  it('posts strategyId/email and always shows the generic success message', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, message: 'whatever the backend feels like saying' })
    })

    const { wrapper } = mountAuthLoginPanel()
    await vi.waitFor(() => expect(API_CLIENT.get).toHaveBeenCalled())
    await wrapper.vm.$nextTick()

    const forgotBtn = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('Forgot Password'))
    await forgotBtn.trigger('click')
    await wrapper.vm.$nextTick()

    await wrapper.find('input[autocomplete="email"]').setValue('ada@example.com')
    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(API_CLIENT.post).toHaveBeenCalled())

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/auth/forgotPassword', {
      json: {
        strategyId: 'strategy-1',
        email: 'ada@example.com'
      }
    })

    await vi.waitFor(() => expect(notifyQueue.length).toBeGreaterThan(0))
    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
    expect(notifyQueue.find((n) => n.type === 'positive')?.message).toBe(
      'Check your emails for password reset instructions!'
    )
  })
})

/**
 * The reset screen this task adds: reached only by landing on `/login/reset-password/:token` (where
 * `mail.ts`'s forgot-password email points), never by clicking through the panel. `resetPassword()` on
 * the backend always finishes via `afterLoginChecks()` -- `nextAction: 'provideTfa'` here proves the
 * response is handed to the same `handleLoginResponse()` every other login path uses, exercised the
 * same way the register tests above exercise it with `changePassword`.
 */
describe('AuthLoginPanel reset password', () => {
  it('detects the token in the URL, shows the reset screen, and submits strategyId/token/newPassword', async () => {
    window.history.replaceState(null, '', '/login/reset-password/tok-abc')
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })
    API_CLIENT.put.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ ok: true, nextAction: 'provideTfa', continuationToken: 'cont-1' })
    })

    const { wrapper } = mountAuthLoginPanel()
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('Choose a new password for your account:')
    )

    const pwdInputs = wrapper.findAll('input[autocomplete="new-password"]')
    await pwdInputs[0].setValue('supersecret1')
    await pwdInputs[1].setValue('supersecret1')
    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(API_CLIENT.put).toHaveBeenCalled())

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/auth/resetPassword', {
      json: {
        strategyId: 'strategy-1',
        token: 'tok-abc',
        newPassword: 'supersecret1'
      },
      throwHttpErrors: expect.any(Function)
    })

    await vi.waitFor(() => expect(wrapper.text()).toContain('Security code required:'))
    expect(
      notifyQueue.some(
        (n) => n.type === 'positive' && n.message === 'Your password has been changed.'
      )
    ).toBe(true)
  })

  it('does nothing when there is no reset token in the URL', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })

    const { wrapper } = mountAuthLoginPanel()
    await vi.waitFor(() => expect(API_CLIENT.get).toHaveBeenCalled())
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('Choose a new password for your account:')
  })
})
