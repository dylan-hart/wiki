import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AuthRegisterScreen from './AuthRegisterScreen.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { useDark } from '@/composables/dark'
import { mountWithApp } from '../../test/mount.js'

/**
 * Self-registration collects First Name and Last Name outright: nothing is ever split, the display
 * name derives from the halves server-side, and there is deliberately no display-name field here.
 */
const MESSAGES = {
  auth: {
    registerSubTitle: 'Create an account',
    registering: 'Registering...',
    fields: {
      firstName: 'First Name',
      lastName: 'Last Name',
      email: 'Email Address',
      password: 'Password',
      verifyPassword: 'Verify Password'
    },
    actions: { register: 'Register' },
    switchToLogin: { link: 'Back to login' },
    errors: {
      register: 'Some fields are missing or invalid.',
      missingFirstName: 'First name is missing.',
      invalidName: 'Name is invalid.',
      missingEmail: 'Email is missing.',
      invalidEmail: 'Email is invalid.',
      missingPassword: 'Password is missing.',
      passwordTooShort: 'Password is too short.',
      missingVerifyPassword: 'Please confirm the password.',
      passwordsNotMatch: 'Passwords do not match.'
    }
  },
  error: { ERR_REGISTRATION_FAILED: 'Registration failed.' }
}

function mountScreen() {
  return mountWithApp(AuthRegisterScreen, {
    props: { screen: 'register', strategyId: 'strat-local' },
    messages: MESSAGES,
    stores: {
      site: (store) => {
        store.id = 'site-1'
      }
    }
  }).wrapper
}

/**
 * The auth screens draw no label above a field: the name lives on the placeholder and on
 * `aria-label`, which `WInput` puts on the `<input>` itself, never on an ancestor.
 */
function inputLabelled(wrapper, text) {
  const input = wrapper.find(`input[aria-label="${text}"]`)
  return input.exists() ? input : null
}

async function fillValidForm(wrapper) {
  wrapper.vm.state.newFirstName = 'Jane'
  wrapper.vm.state.newLastName = 'Doe'
  wrapper.vm.state.newEmail = 'jane@example.com'
  wrapper.vm.state.newPassword = 'a-strong-password'
  wrapper.vm.state.newPasswordVerify = 'a-strong-password'
  await flushPromises()
}

describe('AuthRegisterScreen first/last name fields', () => {
  it('renders a first name and a last name field, and no single name or display name field', () => {
    const wrapper = mountScreen()

    expect(inputLabelled(wrapper, 'First Name')).not.toBeNull()
    expect(inputLabelled(wrapper, 'Last Name')).not.toBeNull()
    const names = wrapper.findAll('input[aria-label]').map((el) => el.attributes('aria-label'))
    expect(names).not.toContain('Name')
    expect(names).not.toContain('Display Name')
  })

  it('gives each half the autocomplete token browsers fill a name from', () => {
    const wrapper = mountScreen()

    expect(inputLabelled(wrapper, 'First Name').attributes('autocomplete')).toBe('given-name')
    expect(inputLabelled(wrapper, 'Last Name').attributes('autocomplete')).toBe('family-name')
  })

  it('sends both halves and no name in the registration payload', async () => {
    const wrapper = mountScreen()
    await fillValidForm(wrapper)

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, nextAction: 'verify' })
    })

    await wrapper.vm.register()
    await flushPromises()

    const [url, options] = API_CLIENT.post.mock.calls.at(-1)
    expect(url).toBe('sites/site-1/auth/register')
    expect(options.json).toMatchObject({
      strategyId: 'strat-local',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com'
    })
    expect(options.json).not.toHaveProperty('name')
    expect(wrapper.emitted('registered')).toBeTruthy()
  })

  it('registers a mononym: an empty last name is valid and is still sent', async () => {
    const wrapper = mountScreen()
    await fillValidForm(wrapper)
    wrapper.vm.state.newFirstName = 'Prince'
    wrapper.vm.state.newLastName = ''
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, nextAction: 'verify' })
    })

    await wrapper.vm.register()
    await flushPromises()

    expect(API_CLIENT.post.mock.calls.at(-1)[1].json).toMatchObject({
      firstName: 'Prince',
      lastName: ''
    })
    expect(wrapper.emitted('registered')).toBeTruthy()
  })

  it('refuses a missing first name before any request is made', async () => {
    const wrapper = mountScreen()
    await fillValidForm(wrapper)
    wrapper.vm.state.newFirstName = ''
    await flushPromises()

    API_CLIENT.post.mockClear()
    notifyQueue.splice(0, notifyQueue.length)

    await wrapper.vm.register()
    await flushPromises()

    expect(API_CLIENT.post).not.toHaveBeenCalled()
    expect(wrapper.find('[role="alert"]').text()).toContain('Some fields are missing or invalid.')
    expect(notifyQueue.some((n) => n.type === 'negative')).toBe(false)
    expect(wrapper.emitted('registered')).toBeUndefined()
  })
})

/**
 * A failed registration is a persistent `role="alert"` block above the fields, not a toast: it
 * stays until the next submit or the next edit to any field.
 */
describe('AuthRegisterScreen inline registration errors', () => {
  function alertOf(wrapper) {
    return wrapper.find('[role="alert"]')
  }

  function failNextRegistration(message) {
    const err = Object.assign(new Error('Request failed with status code 409'), {
      data: { message }
    })
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.reject(err) })
  }

  async function submitFailingRegistration(wrapper, message = 'That email is already in use.') {
    await fillValidForm(wrapper)
    failNextRegistration(message)
    notifyQueue.splice(0, notifyQueue.length)
    await wrapper.vm.register()
    await flushPromises()
  }

  it('renders the server message as an alert and pushes no negative toast', async () => {
    const wrapper = mountScreen()
    await submitFailingRegistration(wrapper)

    expect(wrapper.findAll('[role="alert"]')).toHaveLength(1)
    expect(alertOf(wrapper).text()).toContain('That email is already in use.')
    expect(notifyQueue.some((n) => n.type === 'negative')).toBe(false)
    expect(wrapper.emitted('registered')).toBeUndefined()
  })

  it('localizes an ERR_ code from the server', async () => {
    const wrapper = mountScreen()
    await submitFailingRegistration(wrapper, 'ERR_REGISTRATION_FAILED')

    expect(alertOf(wrapper).text()).toContain('Registration failed.')
  })

  it('draws the alert above the fields', async () => {
    const wrapper = mountScreen()
    await submitFailingRegistration(wrapper)

    const html = wrapper.html()
    expect(html.indexOf('role="alert"')).toBeGreaterThan(-1)
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf('<form'))
  })

  it('stays put until a field is edited, then clears', async () => {
    const wrapper = mountScreen()
    await submitFailingRegistration(wrapper)
    await flushPromises()
    expect(alertOf(wrapper).exists()).toBe(true)

    await inputLabelled(wrapper, 'Email Address').setValue('jane2@example.com')
    await flushPromises()

    expect(alertOf(wrapper).exists()).toBe(false)
  })

  it('clears when the form is resubmitted', async () => {
    const wrapper = mountScreen()
    await submitFailingRegistration(wrapper)
    expect(alertOf(wrapper).exists()).toBe(true)

    let resolvePost
    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        new Promise((resolve) => {
          resolvePost = resolve
        })
    })
    const pending = wrapper.vm.register()
    await flushPromises()
    expect(alertOf(wrapper).exists()).toBe(false)

    resolvePost({ ok: true, nextAction: 'verify' })
    await pending
    await flushPromises()
    expect(wrapper.emitted('registered')).toBeTruthy()
    expect(alertOf(wrapper).exists()).toBe(false)
  })
})

/**
 * `--color-accent-fill` has no dark-mode override, so a static `accent-fill` prop draws the
 * light-mode tone against a dark ground.
 */
describe('AuthRegisterScreen check-email glyph dark mode (OpenProject #2807)', () => {
  afterEach(() => {
    document.body.classList.remove('body--dark', 'body--light')
  })

  it('draws accent-fill under light mode', () => {
    useDark().set(false)
    const wrapper = mountWithApp(AuthRegisterScreen, {
      props: { screen: 'registerCheckEmail', strategyId: 'strat-local' },
      messages: MESSAGES,
      stores: {
        site: (store) => {
          store.id = 'site-1'
        }
      }
    }).wrapper

    const icon = wrapper.find('[data-icon="tabler:mail-opened"]')
    expect(icon.classes()).toContain('text-accent-fill')
    expect(icon.classes()).not.toContain('text-accent-dark')
  })

  it('swaps to accent-dark under dark mode', () => {
    useDark().set(true)
    const wrapper = mountWithApp(AuthRegisterScreen, {
      props: { screen: 'registerCheckEmail', strategyId: 'strat-local' },
      messages: MESSAGES,
      stores: {
        site: (store) => {
          store.id = 'site-1'
        }
      }
    }).wrapper

    const icon = wrapper.find('[data-icon="tabler:mail-opened"]')
    expect(icon.classes()).toContain('text-accent-dark')
    expect(icon.classes()).not.toContain('text-accent-fill')
  })
})
