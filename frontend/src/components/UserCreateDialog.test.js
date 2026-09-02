import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import UserCreateDialog from './UserCreateDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { useAdminStore } from '@/stores/admin'

import { createTestI18n } from '../../test/i18n.js'

/*
  `WDialog`'s content lives behind a `<teleport to="body">`, which lands it as a REAL child of
  `document.body`, outside `@vue/test-utils`'s own tracked tree -- unmounting the wrapper is what
  removes it again. Without this, a second test's `document.body.querySelectorAll(...)` would also
  see the first test's now-orphaned dialog.
*/
let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
})

/**
 * Regression coverage for OpenProject #961: the toggle used to be permanently disabled because
 * `POST /users` hard-rejected `sendWelcomeEmail: true` unconditionally (OpenProject #798's
 * workaround) -- `models/mail.ts` has been a full SMTP transport, used by registration and password
 * reset, since well before that fix landed. Now that the backend actually supports the flag (refusing
 * only when no mail transport is configured, which this dialog cannot know client-side), the toggle
 * is interactive and reveals the "from site" field once turned on.
 */
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
 * Regression coverage for OpenProject #2092: `create()` used to read `err.message` in its catch,
 * which is ky's generic status-line text, not the server's actual reason -- and the `if (!resp?.ok)`
 * guard meant to surface that reason never ran anyway, because `boot/api.js`'s ky instance throws an
 * `HTTPError` (parsing the body into `err.data` before throwing) on any non-2xx response, well before
 * `.json()` ever resolves into `resp`. So a duplicate-email 400 from `POST /users` --
 * `new CustomError('userCreateDuplicateEmail', 'A user with this email already exists.')` -- reached
 * the admin only as a bare status code. `create()` must read the body via `apiErrorMessage()` instead,
 * with the dead `resp.ok` branch deleted rather than left unreachable behind it.
 */
function httpError(message) {
  return Object.assign(new Error('Request failed with status code 400: POST /users'), {
    name: 'HTTPError',
    data: { message }
  })
}

async function fillValidForm(wrapper) {
  wrapper.vm.state.userName = 'Jane Doe'
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

    // -> No `ok` field in the body at all -- proof that success no longer depends on the deleted
    //    `resp.ok` guard, which ky's throw-on-non-2xx behavior made unreachable in the first place.
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

    // Two toggles exist (must-change-password, then send-welcome-email); neither is disabled.
    const toggles = document.body.querySelectorAll('.w-toggle')
    expect(toggles).toHaveLength(2)
    expect(toggles[0].disabled).toBe(false)
    expect(toggles[1].disabled).toBe(false)

    // Only the groups select is present until the toggle is turned on.
    expect(document.body.querySelectorAll('.w-select')).toHaveLength(1)
  })

  it('reveals a single-value from-site select, pre-filled with the current site, once turned on', async () => {
    mountDialog()
    await flushPromises()

    document.body.querySelectorAll('.w-toggle')[1].click()
    await flushPromises()

    expect(document.body.querySelectorAll('.w-select')).toHaveLength(2)
    // -> Single-select displays the chosen option's label as plain text; a `multiple` select (the
    //    pre-fix bug: this field used `multiple` while the rest of the component treated it as one
    //    siteId string) would render it as a removable `w-chip` instead. adminStore.currentSiteId
    //    ('site-1') is what the field is pre-filled with on mount.
    expect(document.body.textContent).toContain('My Site')
    expect(document.body.querySelectorAll('.w-chip')).toHaveLength(0)
  })
})

/**
 * Regression coverage for #1767: `create()` used to test the resolved 400's `resp?.ok` and throw a
 * translated message built from `resp.error`/`resp.message` -- dead once `boot/api.js` throws on
 * 400 instead of resolving it. The `catch` now reads the same two fields off `err.data`.
 */
describe('UserCreateDialog: create() failure path', () => {
  it('shows the server error message on a refused create, translated by error code', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    wrapper.vm.state.userName = 'New User'
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

    // -> No translation exists for `admin.users.createEmailExists` in this test's i18n instance, so
    //    `t()` falls back to the server's own message -- exactly what the removed `resp?.ok` branch
    //    used to show.
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'A user with this email already exists.'
    })
  })
})
