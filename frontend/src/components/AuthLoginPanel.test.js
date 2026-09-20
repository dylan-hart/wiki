import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AuthLoginPanel from './AuthLoginPanel.vue'
import { useSiteStore } from '@/stores/site'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Both the 6-digit authenticator code and a recovery code go through the same
 * `PUT sites/:siteId/auth/tfa` call -- the backend tells the two apart by shape.
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
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })

  const { wrapper } = mountWithApp(AuthLoginPanel, { stores: { site: { id: 'site-1' } } })
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
 * `POST sites/:siteId/auth/register` answers two shapes: `nextAction: 'verify'` (email validation
 * on -- show the check-your-email screen rather than auto-logging in) and any other `nextAction`
 * (email validation off -- falls through to the same `handleLoginResponse()` every other login path
 * uses, exercised here via `changePassword` since it needs no real navigation to observe).
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
 * `onMounted` focuses the username field itself -- `WInput.vue` exposes no `autofocus` prop -- ahead
 * of the `fetchStrategies()` round trip, so the caret lands on first paint rather than after the
 * response. Only while `detectResetToken()` leaves the screen on `login`, so a
 * `/login/reset-password/:token` visit keeps the field `switchTo('reset')` focuses instead.
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
  it('posts strategyId/firstName/lastName/email/password to the REST endpoint and shows the check-email screen on nextAction: verify', async () => {
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

    await wrapper.find('input[autocomplete="given-name"]').setValue('Ada')
    await wrapper.find('input[autocomplete="family-name"]').setValue('Lovelace')
    await wrapper.find('input[autocomplete="email"]').setValue('ada@example.com')
    await wrapper.find('input[autocomplete="new-password"]').setValue('supersecret1')
    await wrapper.findAll('input[autocomplete="new-password"]')[1].setValue('supersecret1')

    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(API_CLIENT.post).toHaveBeenCalled())

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/auth/register', {
      json: {
        strategyId: 'strategy-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
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

    await wrapper.find('input[autocomplete="given-name"]').setValue('Ada')
    await wrapper.find('input[autocomplete="family-name"]').setValue('Lovelace')
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

/** `?all=1` also fetches strategies an admin has configured but not yet marked Visible. */
describe('AuthLoginPanel show-all-strategies escape hatch', () => {
  it('defaults to visibleOnly when no `all` param is present', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })

    mountAuthLoginPanel()
    await vi.waitFor(() => expect(API_CLIENT.get).toHaveBeenCalled())

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/auth/strategies', {
      searchParams: { visibleOnly: true }
    })
  })

  it('passes visibleOnly: false for ?all=1', async () => {
    window.history.replaceState(null, '', '/login?all=1')
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })

    mountAuthLoginPanel()
    await vi.waitFor(() => expect(API_CLIENT.get).toHaveBeenCalled())

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/auth/strategies', {
      searchParams: { visibleOnly: false }
    })
  })

  it('also accepts a bare ?all with no value', async () => {
    window.history.replaceState(null, '', '/login?all')
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })

    mountAuthLoginPanel()
    await vi.waitFor(() => expect(API_CLIENT.get).toHaveBeenCalled())

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/auth/strategies', {
      searchParams: { visibleOnly: false }
    })
  })

  it('ignores an unrelated query param', async () => {
    window.history.replaceState(null, '', '/login?foo=bar')
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([REGISTRATION_STRATEGY]) })

    mountAuthLoginPanel()
    await vi.waitFor(() => expect(API_CLIENT.get).toHaveBeenCalled())

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/auth/strategies', {
      searchParams: { visibleOnly: true }
    })
  })
})

/**
 * `POST sites/:siteId/auth/forgotPassword` always answers the same generic 200 whatever it did
 * behind the scenes, so this checks only the request shape and the fixed success message, never a
 * branch on the response.
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
   * A 429 from `limitAuthAttempts` carries the actionable retry-after text in `err.data.message`,
   * which is why the catch has to go through `apiErrorMessage(err)`: ky's own `err.message` for a
   * non-2xx is a content-free "Request failed with status code 429".
   */
  it('shows the backend message on failure instead of a generic ky error', async () => {
    // -> Not LOCAL_STRATEGY: its `allowForgotPassword: false` would hide the very button this test
    //    needs to click.
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

    await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(true))
    expect(wrapper.find('[role="alert"]').text()).toContain(
      'Too many attempts. Try again in 5 minute(s).'
    )
    expect(notifyQueue.some((n) => n.type === 'negative')).toBe(false)
  })
})

/**
 * The reset screen is reached only by landing on `/login/reset-password/:token`, where the
 * forgot-password email points, never by clicking through the panel. The `provideTfa` response
 * proves it is handed to the same `handleLoginResponse()` every other login path uses.
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
 * `resp.redirect` on a successful login is a group's `redirectOnLogin`: validated server-side, but
 * checked again here as defence in depth. `javascript:…` parses as a valid `URL` with no error, so
 * the check cannot be a bare try/catch around `new URL()` — it has to look at the scheme.
 */
describe('AuthLoginPanel redirect handling (OpenProject #2208)', () => {
  async function mountAndLogin(redirect) {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })

    const { wrapper } = mountWithApp(AuthLoginPanel, { stores: { site: { id: 'site-1' } } })
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

/**
 * A failure is a persistent `role="alert"` block above the fields rather than a toast: it stays
 * until the next submit, an edit to a field, or a change of screen.
 */
describe('AuthLoginPanel inline errors', () => {
  const FORGOT_STRATEGY = {
    ...LOCAL_STRATEGY,
    activeStrategy: { ...LOCAL_STRATEGY.activeStrategy, allowForgotPassword: true }
  }

  function serverError(message) {
    return Object.assign(new Error('Request failed with status code 401'), { data: { message } })
  }

  function alertOf(wrapper) {
    return wrapper.find('[role="alert"]')
  }

  function expectNoNegativeToast() {
    expect(notifyQueue.some((n) => n.type === 'negative')).toBe(false)
  }

  async function mountPanelWith(strategy = LOCAL_STRATEGY) {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([strategy]) })
    const { wrapper } = mountWithApp(AuthLoginPanel, { stores: { site: { id: 'site-1' } } })
    await flushPromises()
    return wrapper
  }

  async function submitLogin(wrapper, putResult) {
    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('reader@example.com')
    await inputs[1].setValue('correct horse battery staple')
    API_CLIENT.put.mockReturnValueOnce(putResult)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
  }

  const failWith = (message) => ({ json: () => Promise.reject(serverError(message)) })

  it('shows a failed login in an alert with the localized text and no negative toast', async () => {
    const wrapper = await mountPanelWith()
    await submitLogin(wrapper, failWith('Invalid credentials.'))

    expect(alertOf(wrapper).exists()).toBe(true)
    expect(alertOf(wrapper).text()).toContain('Invalid credentials.')
    expectNoNegativeToast()
  })

  it('localizes an ERR_ code from the backend through the error namespace', async () => {
    const wrapper = await mountPanelWith()
    await submitLogin(wrapper, failWith('ERR_INVALID_LOGIN'))

    expect(alertOf(wrapper).text()).toContain('error.ERR_INVALID_LOGIN')
  })

  it('shows a login the backend refuses with ok: false the same way', async () => {
    const wrapper = await mountPanelWith()
    await submitLogin(wrapper, {
      json: () => Promise.resolve({ ok: false, message: 'Account disabled.' })
    })

    expect(alertOf(wrapper).text()).toContain('Account disabled.')
    expectNoNegativeToast()
  })

  it('clears the alert when the next submit starts', async () => {
    const wrapper = await mountPanelWith()
    await submitLogin(wrapper, failWith('Invalid credentials.'))
    expect(alertOf(wrapper).exists()).toBe(true)

    API_CLIENT.put.mockReturnValueOnce({ json: () => new Promise(() => {}) })
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(alertOf(wrapper).exists()).toBe(false)
  })

  it('clears the alert when the user edits a field', async () => {
    const wrapper = await mountPanelWith()
    await submitLogin(wrapper, failWith('Invalid credentials.'))
    expect(alertOf(wrapper).exists()).toBe(true)

    await wrapper.findAll('input')[1].setValue('another attempt')

    expect(alertOf(wrapper).exists()).toBe(false)
  })

  it('shows an unrecognised next action as an alert that survives the password being blanked', async () => {
    const wrapper = await mountPanelWith()
    await submitLogin(wrapper, {
      json: () => Promise.resolve({ ok: true, nextAction: 'unheard-of', continuationToken: '' })
    })

    expect(alertOf(wrapper).text()).toContain('auth.errors.unexpectedResponse')
    expectNoNegativeToast()
  })

  it('shows a failed forgot-password request in an alert and clears it on screen switch', async () => {
    const wrapper = await mountPanelWith(FORGOT_STRATEGY)
    await findButtonByText(wrapper, 'auth.forgotPasswordLink').trigger('click')
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce(failWith('Too many attempts.'))
    await wrapper.find('input[autocomplete="email"]').setValue('ada@example.com')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(alertOf(wrapper).text()).toContain('Too many attempts.')
    expectNoNegativeToast()

    await findButtonByText(wrapper, 'auth.forgotPasswordCancel').trigger('click')
    await flushPromises()

    expect(alertOf(wrapper).exists()).toBe(false)
  })

  it('shows a failed reset-password request in an alert', async () => {
    window.history.replaceState(null, '', '/login/reset-password/tok-abc')
    const wrapper = await mountPanelWith()
    await vi.waitFor(() =>
      expect(wrapper.find('input[autocomplete="new-password"]').exists()).toBe(true)
    )

    const pwdInputs = wrapper.findAll('input[autocomplete="new-password"]')
    await pwdInputs[0].setValue('supersecret1')
    await pwdInputs[1].setValue('supersecret1')
    API_CLIENT.put.mockReturnValueOnce(failWith('This reset link has expired.'))
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(alertOf(wrapper).text()).toContain('This reset link has expired.')
    expectNoNegativeToast()
  })

  it('shows a failed change-password request in an alert', async () => {
    const wrapper = await mountPanelWith()
    await submitLogin(wrapper, {
      json: () =>
        Promise.resolve({ ok: true, nextAction: 'changePassword', continuationToken: 'ct-1' })
    })
    expect(alertOf(wrapper).exists()).toBe(false)

    const pwdInputs = wrapper.findAll('input[autocomplete="new-password"]')
    await pwdInputs[0].setValue('supersecret1')
    await pwdInputs[1].setValue('supersecret1')
    API_CLIENT.put.mockReturnValueOnce(failWith('Password too weak.'))
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(alertOf(wrapper).text()).toContain('Password too weak.')
    expectNoNegativeToast()
  })

  it('shows a provider redirect failure with its caption and strips the query param', async () => {
    window.history.replaceState(null, '', '/login?error=ERR_AUTH_FAILED')
    const wrapper = await mountPanelWith()

    expect(alertOf(wrapper).text()).toContain('auth.errors.loginError')
    expect(alertOf(wrapper).text()).toContain('error.ERR_AUTH_FAILED')
    expect(window.location.search).toBe('')
    expectNoNegativeToast()
  })
})
