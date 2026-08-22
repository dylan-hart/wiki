import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import UserCreateDialog from './UserCreateDialog.vue'
import { useAdminStore } from '@/stores/admin'

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

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: { admin: { users: {} } } }
  })

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })

  currentWrapper = mount(UserCreateDialog, { global: { plugins: [i18n] } })
  return currentWrapper
}

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
