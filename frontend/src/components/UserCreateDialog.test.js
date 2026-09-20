import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import UserCreateDialog from './UserCreateDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { useAdminStore } from '@/stores/admin'

import { createTestI18n } from '../../test/i18n.js'

/*
  `WDialog` teleports its content to a real child of `document.body`, outside test-utils' tracked
  tree, and only unmounting the wrapper removes it -- otherwise the next test's
  `document.body.querySelectorAll(...)` also sees this one's orphaned dialog.
*/
let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
})

function mountDialog() {
  setActivePinia(createPinia())

  const adminStore = useAdminStore()
  adminStore.sites = [{ id: 'site-1', title: 'My Site' }]
  adminStore.currentSiteId = 'site-1'

  const i18n = createTestI18n({ admin: { users: {} } })

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })

  currentWrapper = mount(UserCreateDialog, { global: { plugins: [i18n] } })
  return currentWrapper
}

/**
 * Shaped like what `boot/api.js`'s ky instance throws on any non-2xx: an `HTTPError` whose generic
 * status-line `message` is useless, with the server's own reason parsed into `data`.
 */
function httpError(message) {
  return Object.assign(new Error('Request failed with status code 400: POST /users'), {
    name: 'HTTPError',
    data: { message }
  })
}

async function fillValidForm(wrapper) {
  wrapper.vm.state.userFirstName = 'Jane'
  wrapper.vm.state.userLastName = 'Doe'
  wrapper.vm.state.userEmail = 'jane@example.com'
  wrapper.vm.state.userPassword = 'a-strong-password'
  wrapper.vm.state.userGroups = ['group-1']
  await flushPromises()
}

describe('UserCreateDialog create() error handling', () => {
  it("surfaces the server's duplicate-email sentence, not a bare status code", async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await fillValidForm(wrapper)

    API_CLIENT.post.mockImplementationOnce(() => {
      throw httpError('A user with this email already exists.')
    })

    await wrapper.vm.create()

    expect(notifyQueue.at(-1)?.message).toBe('A user with this email already exists.')
    expect(notifyQueue.at(-1)?.type).toBe('negative')
    expect(wrapper.emitted('ok')).toBeUndefined()
  })

  it('creates successfully with no `resp.ok` check standing between a 2xx response and the toast', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await fillValidForm(wrapper)

    // -> No `ok` field in the body: ky throws on non-2xx, so success must not depend on one.
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ id: 'user-1' }) })

    await wrapper.vm.create()

    expect(notifyQueue.at(-1)?.type).toBe('positive')
    expect(wrapper.emitted('ok')).toBeTruthy()
  })
})

describe('UserCreateDialog send welcome email toggle', () => {
  it('renders both toggles enabled, with the from-site field hidden until turned on', async () => {
    mountDialog()
    await flushPromises()

    // -> In order: must-change-password, then send-welcome-email.
    const toggles = document.body.querySelectorAll('.w-toggle')
    expect(toggles).toHaveLength(2)
    expect(toggles[0].disabled).toBe(false)
    expect(toggles[1].disabled).toBe(false)

    expect(document.body.querySelectorAll('.w-select')).toHaveLength(1)
  })

  it('reveals a single-value from-site select, pre-filled with the current site, once turned on', async () => {
    mountDialog()
    await flushPromises()

    document.body.querySelectorAll('.w-toggle')[1].click()
    await flushPromises()

    expect(document.body.querySelectorAll('.w-select')).toHaveLength(2)
    // -> A single select shows its chosen label as plain text, where a `multiple` one would draw a
    //    removable `w-chip` -- which is the tell that this field is not `multiple`.
    expect(document.body.textContent).toContain('My Site')
    expect(document.body.querySelectorAll('.w-chip')).toHaveLength(0)
  })
})

describe('UserCreateDialog: create() failure path', () => {
  it('shows the server error message on a refused create, translated by error code', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    wrapper.vm.state.userFirstName = 'New'
    wrapper.vm.state.userLastName = 'User'
    wrapper.vm.state.userEmail = 'new@example.com'
    wrapper.vm.state.userPassword = 'a-long-enough-password'
    wrapper.vm.state.userGroups = ['group-1']
    await flushPromises()

    notifyQueue.splice(0, notifyQueue.length)
    const err = new Error('Bad Request')
    err.data = {
      ok: false,
      error: 'createEmailExists',
      statusCode: 400,
      message: 'A user with this email already exists.'
    }
    API_CLIENT.post.mockImplementationOnce(() => {
      throw err
    })

    await wrapper.vm.create()
    await flushPromises()

    // -> This i18n instance carries no `admin.users.createEmailExists`, so `t()` falls back to the
    //    server's own message -- the fallback being what is under test.
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'A user with this email already exists.'
    })
  })
})

/**
 * No display-name field, deliberately: a new account derives one server-side and stays on
 * derivation until somebody overrides it in the user editor.
 */
describe('UserCreateDialog first/last name fields', () => {
  it('renders a labelled first name and last name, and no display name field', async () => {
    mountDialog()
    await flushPromises()

    // -> These fields carry a floating `label`, not a bare `aria-label`, so `WFieldFrame` renders a
    //    real `<label for>` and that association -- not an attribute on the input -- is the name.
    const labelled = [...document.body.querySelectorAll('label[for]')].map((el) => [
      el.textContent.trim(),
      document.getElementById(el.getAttribute('for'))?.tagName
    ])
    expect(labelled).toContainEqual(['admin.users.firstName', 'INPUT'])
    expect(labelled).toContainEqual(['admin.users.lastName', 'INPUT'])
    const texts = labelled.map(([text]) => text)
    expect(texts).not.toContain('admin.users.name')
    expect(texts).not.toContain('common.field.name')
  })

  it('sends firstName and lastName in the create payload, and no name at all', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await fillValidForm(wrapper)

    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ id: 'user-1' }) })

    await wrapper.vm.create()

    const [url, options] = API_CLIENT.post.mock.calls.at(-1)
    expect(url).toBe('users')
    expect(options.json).toMatchObject({ firstName: 'Jane', lastName: 'Doe' })
    expect(options.json).not.toHaveProperty('name')
  })

  it('accepts a mononym: an empty last name passes validation and is still sent', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    wrapper.vm.state.userFirstName = 'Prince'
    wrapper.vm.state.userLastName = ''
    wrapper.vm.state.userEmail = 'prince@example.com'
    wrapper.vm.state.userPassword = 'a-strong-password'
    wrapper.vm.state.userGroups = ['group-1']
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ id: 'user-2' }) })

    await wrapper.vm.create()

    expect(notifyQueue.at(-1)?.type).toBe('positive')
    expect(API_CLIENT.post.mock.calls.at(-1)[1].json).toMatchObject({
      firstName: 'Prince',
      lastName: ''
    })
  })

  it('refuses a missing first name before any request is made', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    wrapper.vm.state.userFirstName = ''
    wrapper.vm.state.userLastName = 'Doe'
    wrapper.vm.state.userEmail = 'nobody@example.com'
    wrapper.vm.state.userPassword = 'a-strong-password'
    wrapper.vm.state.userGroups = ['group-1']
    await flushPromises()

    API_CLIENT.post.mockClear()
    await wrapper.vm.create()

    expect(API_CLIENT.post).not.toHaveBeenCalled()
    expect(notifyQueue.at(-1)?.type).toBe('negative')
  })

  it('clears both halves when the dialog is kept open for the next account', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await fillValidForm(wrapper)
    wrapper.vm.state.keepOpened = true

    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ id: 'user-1' }) })

    await wrapper.vm.create()

    expect(wrapper.vm.state.userFirstName).toBe('')
    expect(wrapper.vm.state.userLastName).toBe('')
    expect(wrapper.emitted('ok')).toBeUndefined()
  })
})
