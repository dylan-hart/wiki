import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AuthLoginPanel from './AuthLoginPanel.vue'
import { useSiteStore } from '@/stores/site'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

/**
 * Regression coverage for the login-time recovery-code toggle (task 428): switching the `tfa`
 * screen from the 6-digit authenticator field to a recovery-code field, and sending whichever one
 * is active through the same `PUT sites/:siteId/auth/tfa` call the backend already tells apart by
 * shape (task 427).
 */

const LOCAL_STRATEGY = {
  id: 'strat-1',
  activeStrategy: {
    displayName: 'Local',
    selfRegistration: false,
    allowForgotPassword: false,
    strategy: {
      key: 'local',
      useForm: true,
      usernameType: 'email',
      icon: 'local.svg'
    }
  }
}

async function mountAtTfaScreen() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })

  const i18n = createTestI18n()
  const wrapper = mount(AuthLoginPanel, {
    global: { plugins: [i18n] }
  })
  await flushPromises()

  const inputs = wrapper.findAll('input')
  await inputs[0].setValue('reader@example.com')
  await inputs[1].setValue('correct horse battery staple')

  API_CLIENT.put.mockReturnValueOnce({
    json: () =>
      Promise.resolve({
        ok: true,
        nextAction: 'provideTfa',
        continuationToken: 'ct-1'
      })
  })
  await wrapper.find('form').trigger('submit')
  await flushPromises()

  return wrapper
}

function findButtonByText(wrapper, text) {
  return wrapper.findAll('button').find((b) => b.text() === text)
}

describe('AuthLoginPanel recovery code toggle', () => {
  it('starts the tfa screen on the 6-digit authenticator field, with no recovery field shown', async () => {
    const wrapper = await mountAtTfaScreen()

    expect(wrapper.find('input[placeholder="XXXX-XXXX-XXXX-XXXX"]').exists()).toBe(false)
    expect(findButtonByText(wrapper, 'auth.tfa.useRecoveryCode')).toBeTruthy()
  })

  it('toggling swaps in the recovery-code field and flips the toggle label', async () => {
    const wrapper = await mountAtTfaScreen()

    await findButtonByText(wrapper, 'auth.tfa.useRecoveryCode').trigger('click')

    expect(wrapper.find('input[placeholder="XXXX-XXXX-XXXX-XXXX"]').exists()).toBe(true)
    expect(findButtonByText(wrapper, 'auth.tfa.useSecurityCode')).toBeTruthy()
  })

  it('formats typed recovery code input into dash-grouped uppercase as the user types', async () => {
    const wrapper = await mountAtTfaScreen()
    await findButtonByText(wrapper, 'auth.tfa.useRecoveryCode').trigger('click')

    const recoveryInput = wrapper.find('input[placeholder="XXXX-XXXX-XXXX-XXXX"]')
    await recoveryInput.setValue('abcd1234efgh5678')

    expect(recoveryInput.element.value).toBe('ABCD-1234-EFGH-5678')
  })

  it('submits the formatted recovery code as securityCode through the same tfa endpoint', async () => {
    const wrapper = await mountAtTfaScreen()
    await findButtonByText(wrapper, 'auth.tfa.useRecoveryCode').trigger('click')

    const recoveryInput = wrapper.find('input[placeholder="XXXX-XXXX-XXXX-XXXX"]')
    await recoveryInput.setValue('abcd1234efgh5678')

    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, nextAction: 'redirect', continuationToken: '' })
    })
    await findButtonByText(wrapper, 'auth.tfa.verifyToken').trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenLastCalledWith(
      'sites/site-1/auth/tfa',
      expect.objectContaining({
        json: expect.objectContaining({
          strategyId: 'strat-1',
          securityCode: 'ABCD-1234-EFGH-5678',
          setup: false
        })
      })
    )
  })

  it('rejects an incomplete recovery code client-side rather than submitting it', async () => {
    const wrapper = await mountAtTfaScreen()
    await findButtonByText(wrapper, 'auth.tfa.useRecoveryCode').trigger('click')

    const recoveryInput = wrapper.find('input[placeholder="XXXX-XXXX-XXXX-XXXX"]')
    await recoveryInput.setValue('abcd12')

    const putCallsBefore = API_CLIENT.put.mock.calls.length
    await findButtonByText(wrapper, 'auth.tfa.verifyToken').trigger('click')
    await flushPromises()

    expect(API_CLIENT.put.mock.calls.length).toBe(putCallsBefore)
  })
})

/**
 * `register()` used to be a dead `APOLLO_CLIENT.mutate(...)` call (there is no GraphQL server left --
 * see CLAUDE.md's "GraphQL was removed") that also never sent `strategyId`, which the REST route
 * requires. This covers the two shapes `POST sites/:siteId/auth/register` answers with: `nextAction:
 * 'verify'` (email validation on -- show the check-your-email screen rather than auto-logging in) and
 * any other `nextAction` (email validation off -- falls straight through to the same
 * `handleLoginResponse()` every other login path already uses, exercised here via `changePassword`
 * since it needs no real navigation to observe).
 */

const REGISTRATION_STRATEGY = {
  id: 'strategy-1',
  activeStrategy: {
    displayName: 'Local',
    selfRegistration: true,
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

  const i18n = createTestI18n({
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
  })

  const wrapper = mount(AuthLoginPanel, {
    global: {
      plugins: [i18n]
    },
    attachTo: document.body
  })

  return { wrapper, siteStore }
}

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
  window.history.replaceState(null, '', '/login')
})

/**
 * OpenProject #1671: the username field's bare `autofocus` attribute never did anything -- `WInput.vue`
 * exposes no such prop, so arriving at `/login` put the caret nowhere. `onMounted` now focuses it
 * itself, ahead of the `fetchStrategies()` network round trip so it happens on first paint rather than
 * after the response lands -- and only when the reset-password token check (`detectResetToken()`)
 * leaves the screen on `login`, so a `/login/reset-password/:token` visit still gets its own field
 * focused by `switchTo('reset')` instead, not this one stealing it back.
 */
describe('AuthLoginPanel focus on first paint', () => {
  it('focuses the username field on first paint at /login, before strategies have loaded', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })

    const { wrapper } = mountAuthLoginPanel()
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(wrapper.find('input[autocomplete="email"]').element)
  })

  it('does not focus the login field when a reset-password token puts the reset screen up instead', async () => {
    window.history.replaceState(null, '', '/login/reset-password/tok-abc')
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })

    const { wrapper } = mountAuthLoginPanel()
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('Choose a new password for your account:')
    )

    const pwdInputs = wrapper.findAll('input[autocomplete="new-password"]')
    expect(document.activeElement).toBe(pwdInputs[0].element)
  })
})

describe('AuthLoginPanel register', () => {
  it('posts strategyId/name/email/password to the REST endpoint and shows the check-email screen on nextAction: verify', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })
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
      }
    })

    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Check your emails to activate your account.')
  })

  it('routes through handleLoginResponse instead when nextAction is not verify', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })
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
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })

    mountAuthLoginPanel()
    await vi.waitFor(() => expect(notifyQueue.length).toBeGreaterThan(0))

    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
    expect(notifyQueue.find((n) => n.type === 'positive')?.message).toBe(
      'Your email address has been verified. You can now log in.'
    )
    expect(window.location.search).toBe('')
  })

  it('shows nothing when there is no verified param', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })

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
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })
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

  /**
   * The route always answers 200 for a normal request (see above), but `limitAuthAttempts`
   * (`backend/helpers/rateLimit.ts`) can still refuse it with a 429 carrying a specific, actionable
   * `{ message }` -- `reply.tooManyRequests('Too many attempts. Try again in N minute(s).')`, shaped
   * by the global error handler into `{ ok, error, statusCode, message }` per CLAUDE.md. Every other
   * catch block in this file reports a failure via `localizeError(apiErrorMessage(err), t)`, which
   * reads that `err.data.message` first (see `helpers/apiError.js`'s doc comment on why: ky's own
   * `err.message` for a non-2xx is a content-free "Request failed with status code 429"). This one
   * used raw `err.message` instead, so a rate-limited user saw ky's generic text rather than the
   * backend's retry-after guidance every sibling flow (login, register, changePwd, resetPassword)
   * already surfaces correctly.
   */
  it('shows the backend message on failure instead of a generic ky error', async () => {
    // -> Not LOCAL_STRATEGY: its allowForgotPassword is false (that's the point of the fixture
    //    elsewhere in this file), which would hide the very button this test needs to click.
    const forgotPasswordAllowedStrategy = {
      ...LOCAL_STRATEGY,
      activeStrategy: { ...LOCAL_STRATEGY.activeStrategy, allowForgotPassword: true }
    }
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([forgotPasswordAllowedStrategy])
    })
    const rateLimitError = Object.assign(new Error('Request failed with status code 429'), {
      data: { message: 'Too many attempts. Try again in 5 minute(s).' }
    })
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.reject(rateLimitError) })

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

    await vi.waitFor(() => expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true))
    expect(notifyQueue.find((n) => n.type === 'negative')?.message).toBe(
      'Too many attempts. Try again in 5 minute(s).'
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
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })
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
      }
    })

    await vi.waitFor(() => expect(wrapper.text()).toContain('Security code required:'))
    expect(
      notifyQueue.some(
        (n) => n.type === 'positive' && n.message === 'Your password has been changed.'
      )
    ).toBe(true)
  })

  it('does nothing when there is no reset token in the URL', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })

    const { wrapper } = mountAuthLoginPanel()
    await vi.waitFor(() => expect(API_CLIENT.get).toHaveBeenCalled())
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('Choose a new password for your account:')
  })
})

/**
 * OpenProject #1360/#2208 (2026-08-24 security audit §2): `resp.redirect` on a successful login is a
 * group's `redirectOnLogin` (validated server-side, but checked again here as defence in depth
 * against a row written before that validation existed). `javascript:…` parses as a valid `URL` with
 * no error, so this cannot be a bare try/catch around `new URL()` — it has to look at what scheme
 * came back.
 */
describe('AuthLoginPanel redirect handling (OpenProject #2208)', () => {
  async function mountAndLogin(redirect) {
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

    API_CLIENT.put.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ ok: true, nextAction: 'redirect', continuationToken: '', redirect })
    })
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    return wrapper
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('refuses a javascript: redirect and falls back to /', async () => {
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {})
    await mountAndLogin('javascript:alert(1)')

    await vi.advanceTimersByTimeAsync(1000)

    expect(replace).toHaveBeenCalledWith('/')
  })

  it('refuses a scheme-relative //host redirect the same way', async () => {
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {})
    await mountAndLogin('//attacker.example')

    await vi.advanceTimersByTimeAsync(1000)

    expect(replace).toHaveBeenCalledWith('/')
  })

  it('follows a genuine rooted-path redirect', async () => {
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {})
    await mountAndLogin('/dashboard')

    await vi.advanceTimersByTimeAsync(1000)

    expect(replace).toHaveBeenCalledWith('/dashboard')
  })

  it('follows a genuine https:// redirect', async () => {
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {})
    await mountAndLogin('https://idp.example.com/welcome')

    await vi.advanceTimersByTimeAsync(1000)

    expect(replace).toHaveBeenCalledWith('https://idp.example.com/welcome')
  })

  it('falls back to / when the response carries no redirect at all', async () => {
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {})
    await mountAndLogin(undefined)

    await vi.advanceTimersByTimeAsync(1000)

    expect(replace).toHaveBeenCalledWith('/')
  })
})
