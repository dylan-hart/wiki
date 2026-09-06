import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AuthLoginPanel from './AuthLoginPanel.vue'
import AuthRegisterScreen from './AuthRegisterScreen.vue'
import AuthTfaScreens from './AuthTfaScreens.vue'

import { mountWithApp } from '../../test/mount.js'

/*
  The passkey row is gated on `browserSupportsWebAuthn()`, which is false under jsdom -- there is no
  `navigator.credentials` to detect. Reporting support is the only thing this needs from the library;
  nothing here presses the button, so `startAuthentication` is present purely to satisfy the import.
  Hoisted by Vitest, so it takes effect ahead of the component imports below regardless of where it
  is written.
*/
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: vi.fn()
}))

/**
 * The auth panel's chrome, against `ui-redesign/Cardinal Wiki - Login 3x.dc.html` and
 * `- Auth Screens 3x.dc.html` (OpenProject #2627).
 *
 * What this asserts and why it is asserted this way: every band on these screens is a MEASUREMENT
 * the design states (44px for the login submit, 40px for a provider row, 38px for register/forgot,
 * 36px for a strategy chip), and jsdom runs no layout engine, so none of them can be measured here.
 * `WBtn` also writes its own `min-height` as an inline style, which is why the height is expressed
 * as a `size`/`padding` pair at the call site rather than as a class a stylesheet could set --
 * content is `1.715em`, so 14px + 10px of padding is the design's 44px. Asserting the pair is
 * therefore asserting the thing that actually produces the band; a rendered-pixel check would need
 * the real-Chromium harness, and `test/realGridLayout.js#buildAppCss` compiles `css/tailwind.css`
 * only, not the SFC `<style>` blocks these screens are drawn with.
 *
 * The variant claims (outline rather than the old `acrylic-btn` wash, the chrome tone rather than
 * `primary` on four rows, the accent-fill glyph) are the ones that were visibly wrong, and those
 * jsdom can check directly.
 */

const LOCAL_STRATEGY = {
  id: 'strat-1',
  activeStrategy: {
    displayName: 'Local',
    selfRegistration: true,
    allowForgotPassword: true,
    strategy: { key: 'local', useForm: true, usernameType: 'email', icon: 'local.svg' }
  }
}

const LDAP_STRATEGY = {
  id: 'strat-2',
  activeStrategy: {
    displayName: 'LDAP',
    selfRegistration: false,
    allowForgotPassword: false,
    strategy: { key: 'ldap', useForm: true, usernameType: 'username', icon: 'ldap.svg' }
  }
}

const OKTA_STRATEGY = {
  id: 'strat-3',
  activeStrategy: {
    displayName: 'Okta',
    strategy: { key: 'oidc', useForm: false, icon: 'okta.svg' }
  }
}

const MESSAGES = {
  auth: {
    selectAuthProvider: 'Sign in with',
    signingIn: 'Signing In...',
    loginSuccess: 'Login Successful!',
    forgotPasswordLink: 'Forgot Password',
    forgotPasswordSubtitle: 'Enter your email address',
    forgotPasswordCancel: 'Cancel',
    sendResetPassword: 'Reset Password',
    registerSubTitle: 'Fill-in the form below to create an account.',
    registerCheckEmail: 'Check your emails to activate your account.',
    switchToRegister: { link: 'Create an Account' },
    switchToLogin: { link: 'Back to Login' },
    actions: { login: 'Log In', loginWith: 'Continue with {provider}', register: 'Register' },
    fields: {
      email: 'Email Address',
      username: 'Username',
      password: 'Password',
      name: 'Name',
      firstName: 'First Name',
      lastName: 'Last Name',
      verifyPassword: 'Verify Password'
    },
    passkeys: { signin: 'Log In with a Passkey' },
    tfa: {
      subtitle: 'Security code required:',
      verifyToken: 'Verify',
      useRecoveryCode: 'Use a recovery code instead',
      recoveryCodeLabel: 'Recovery Code',
      recoveryCodeHint: 'Enter one of your unused recovery codes.'
    },
    tfaSetupTitle: 'Two-factor authentication is required.',
    tfaSetupInstrFirst: 'Scan the QR code below',
    tfaSetupInstrSecond: 'Enter the security code'
  }
}

async function mountPanel(strategies) {
  API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve(strategies) })

  const { wrapper } = mountWithApp(AuthLoginPanel, {
    messages: MESSAGES,
    stores: { site: { id: 'site-1' } }
  })
  await flushPromises()

  return wrapper
}

function mountRegister(screen) {
  const { wrapper } = mountWithApp(AuthRegisterScreen, {
    messages: MESSAGES,
    props: { screen, strategyId: 'strat-1' },
    stores: { site: { id: 'site-1' } }
  })

  return wrapper
}

function mountTfa(screen, props = {}) {
  const { wrapper } = mountWithApp(AuthTfaScreens, {
    messages: MESSAGES,
    props: { screen, strategyId: 'strat-1', continuationToken: 'ct-1', ...props },
    stores: { site: { id: 'site-1' } }
  })

  return wrapper
}

/** The `WBtn` whose rendered label is exactly `text`. */
function btnByLabel(wrapper, text) {
  return wrapper
    .findAllComponents({ name: 'WBtn' })
    .find((btn) => btn.props('label') === text || btn.text() === text)
}

describe('AuthLoginPanel — the login screen', () => {
  it("carries the design's field chrome and no label above either credential", async () => {
    const wrapper = await mountPanel([LOCAL_STRATEGY])

    const fields = wrapper.findAllComponents({ name: 'WInput' })
    expect(fields).toHaveLength(2)
    for (const field of fields) {
      expect(field.classes()).toContain('auth-field')
      expect(field.props('label')).toBe(null)
    }
    // -> The name moves onto the placeholder and `aria-label`; `WInput` puts the latter on the
    //    `<input>` itself, which is what keeps e2e's `getByLabel('Email Address')` resolving
    expect(wrapper.find('input[aria-label="Email Address"]').exists()).toBe(true)
    expect(wrapper.find('input[aria-label="Password"]').attributes('placeholder')).toBe('Password')
  })

  it("names the first field after the strategy's own username type", async () => {
    const wrapper = await mountPanel([LDAP_STRATEGY])

    expect(wrapper.find('input[aria-label="Username"]').exists()).toBe(true)
  })

  it("draws the submit as the design's 44px accent band with blueprint corner marks", async () => {
    const wrapper = await mountPanel([LOCAL_STRATEGY])
    const submit = btnByLabel(wrapper, 'Log In')

    expect(submit.props('color')).toBe('primary')
    expect(submit.props('outline')).toBe(false)
    expect(submit.props('size')).toBe('14px')
    expect(submit.props('padding')).toBe('10px 16px')
    expect(submit.classes()).toContain('auth-marks')
  })

  it('draws every secondary row as a hairline outline plate, never the old acrylic wash', async () => {
    const wrapper = await mountPanel([LOCAL_STRATEGY, OKTA_STRATEGY])

    const secondary = [
      'Log In with a Passkey',
      'Continue with Okta',
      'Create an Account',
      'Forgot Password'
    ]
    for (const label of secondary) {
      const btn = btnByLabel(wrapper, label)
      expect(btn, label).toBeTruthy()
      expect(btn.props('outline'), label).toBe(true)
      expect(btn.props('flat'), label).toBe(false)
      expect(btn.classes(), label).not.toContain('acrylic-btn')
    }
  })

  it('keeps the accent on the passkey row and the chrome tone on the other three', async () => {
    const wrapper = await mountPanel([LOCAL_STRATEGY, OKTA_STRATEGY])

    expect(btnByLabel(wrapper, 'Log In with a Passkey').props('color')).toBe('primary')
    for (const label of ['Continue with Okta', 'Create an Account', 'Forgot Password']) {
      expect(btnByLabel(wrapper, label).props('color'), label).toBe('slate')
    }
  })

  it('draws the strategy selector as one accent fill among hairline plates', async () => {
    const wrapper = await mountPanel([LOCAL_STRATEGY, LDAP_STRATEGY])

    expect(wrapper.find('p.auth-hint').text()).toBe('Sign in with')
    expect(wrapper.find('.auth-strategies').exists()).toBe(true)
    // -> The row's own 18px is the stylesheet's now; the utility that used to set 16px is gone
    expect(wrapper.find('.auth-strategies').classes()).not.toContain('mb-4')

    const selected = btnByLabel(wrapper, 'Local')
    const other = btnByLabel(wrapper, 'LDAP')
    expect(selected.props('color')).toBe('primary')
    expect(selected.props('outline')).toBe(false)
    expect(other.props('color')).toBe('slate')
    expect(other.props('outline')).toBe(true)
  })

  it("spaces every rule on the login screen at the design's 18px", async () => {
    const wrapper = await mountPanel([LOCAL_STRATEGY, OKTA_STRATEGY])

    const rules = wrapper.findAllComponents({ name: 'WSeparator' })
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule.props('spaced')).toBe('18px')
      expect(rule.classes()).not.toContain('my-4')
    }
  })

  it('takes the same chrome onto the forgot screen, which the design does not draw', async () => {
    const wrapper = await mountPanel([LOCAL_STRATEGY])
    await btnByLabel(wrapper, 'Forgot Password').trigger('click')
    await flushPromises()

    expect(wrapper.find('p.auth-subtitle').text()).toBe('Enter your email address')
    const field = wrapper.findComponent({ name: 'WInput' })
    expect(field.classes()).toContain('auth-field--sm')
    expect(field.props('label')).toBe(null)
    expect(btnByLabel(wrapper, 'Reset Password').classes()).toContain('auth-marks')
    expect(btnByLabel(wrapper, 'Cancel').props('outline')).toBe(true)
  })
})

describe('AuthRegisterScreen', () => {
  it('draws five unlabelled 40px fields and a marked primary', () => {
    const wrapper = mountRegister('register')

    // -> Five, not four: Task #2642 split the one name field into an authored first and last name.
    const fields = wrapper.findAllComponents({ name: 'WInput' })
    expect(fields).toHaveLength(5)
    for (const field of fields) {
      expect(field.classes()).toContain('auth-field--sm')
      expect(field.props('label')).toBe(null)
    }
    expect(wrapper.find('input[aria-label="First Name"]').exists()).toBe(true)
    expect(wrapper.find('input[aria-label="Last Name"]').exists()).toBe(true)

    const submit = btnByLabel(wrapper, 'Register')
    expect(submit.classes()).toContain('auth-marks')
    expect(submit.props('size')).toBe('13.5px')
    expect(submit.props('padding')).toBe('9.5px 16px')
  })

  it('sends the reader back to login through an outline plate in the chrome tone', () => {
    const wrapper = mountRegister('register')
    const back = btnByLabel(wrapper, 'Back to Login')

    expect(back.props('outline')).toBe(true)
    expect(back.props('color')).toBe('slate')
    expect(back.classes()).not.toContain('acrylic-btn')
  })

  it('draws the check-your-email glyph in the bright accent, which carries no text', () => {
    const wrapper = mountRegister('registerCheckEmail')
    const glyph = wrapper.findComponent({ name: 'WIcon' })

    expect(glyph.props('name')).toBe('tabler:mail-opened')
    expect(glyph.props('color')).toBe('accent-fill')
    expect(wrapper.find('p.auth-notice').text()).toContain('Check your emails')
  })
})

describe('AuthTfaScreens', () => {
  it('wraps the digit row so the panel can re-dress it without touching the shared class', () => {
    const wrapper = mountTfa('tfa')

    expect(wrapper.find('.auth-otp').exists()).toBe(true)
    expect(wrapper.find('.auth-otp').classes()).not.toContain('auth-otp--sm')
    expect(wrapper.find('p.auth-subtitle').text()).toBe('Security code required:')
  })

  it('draws the recovery-code alternative as a line of type, not a second button', () => {
    const wrapper = mountTfa('tfa')
    const toggle = btnByLabel(wrapper, 'Use a recovery code instead')

    expect(toggle.props('flat')).toBe(true)
    expect(toggle.props('outline')).toBe(false)
    expect(toggle.props('color')).toBe('text-secondary')
    expect(toggle.props('icon')).toBe(null)
  })

  it('keeps the format placeholder on the recovery-code field the design never drew', async () => {
    const wrapper = mountTfa('tfa')
    await btnByLabel(wrapper, 'Use a recovery code instead').trigger('click')

    const field = wrapper.find('input[aria-label="Recovery Code"]')
    expect(field.exists()).toBe(true)
    expect(field.attributes('placeholder')).toBe('XXXX-XXXX-XXXX-XXXX')
  })

  it("leads the setup screen with the requirement and frames the QR at the design's size", () => {
    const wrapper = mountTfa('tfasetup', { qrImage: '<svg viewBox="0 0 1 1"></svg>' })

    expect(wrapper.find('p.auth-notice--lead').text()).toBe(
      'Two-factor authentication is required.'
    )
    const qr = wrapper.find('.auth-qr')
    expect(qr.exists()).toBe(true)
    expect(qr.find('svg').exists()).toBe(true)
    // -> The setup row is the shorter of the two the design draws
    expect(wrapper.find('.auth-otp').classes()).toContain('auth-otp--sm')
  })
})
