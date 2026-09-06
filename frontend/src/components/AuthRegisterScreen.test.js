import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AuthRegisterScreen from './AuthRegisterScreen.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { mountWithApp } from '../../test/mount.js'

/**
 * Feature #2608, Task #2642: self-registration collects First Name and Last Name outright rather
 * than one string that gets split.
 *
 * The naive whitespace split exists only for a federated provider that hands over a single display
 * name (Task #2641) -- an account created here is this instance's own, so nothing is ever parsed:
 * the halves are authored, and `models/users.ts#resolveNameFields` derives the display name from
 * them server-side. There is deliberately no display name field on this screen; it is reachable in
 * the profile once the account exists, which is where the override belongs.
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
  }
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
 * `WInput` renders a floating `label`, which `WFieldFrame` turns into a real `<label for>` -- so the
 * accessible name comes from that association rather than an `aria-label` attribute on the input.
 * This resolves the control the same way a screen reader would.
 */
function inputLabelled(wrapper, text) {
  const label = wrapper.findAll('label[for]').find((el) => el.text() === text)
  return label ? wrapper.find(`#${label.attributes('for')}`) : null
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
    const labels = wrapper.findAll('label[for]').map((el) => el.text())
    expect(labels).not.toContain('Name')
    expect(labels).not.toContain('Display Name')
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
    expect(notifyQueue.at(-1)?.type).toBe('negative')
    expect(wrapper.emitted('registered')).toBeUndefined()
  })
})
