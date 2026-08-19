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
 * Regression coverage for OpenProject #798: `POST /users` hard-rejects `sendWelcomeEmail: true`
 * because mail delivery isn't implemented in the backend at all yet (`backend/api/users.ts`), so
 * the toggle must come up disabled -- with a caption explaining why -- rather than letting the
 * user flip it on only to have submit fail. The gated "from site" sub-field must stay hidden too.
 */
function mountDialog() {
  setActivePinia(createPinia())

  const adminStore = useAdminStore()
  adminStore.sites = [{ id: 'site-1', title: 'My Site' }]
  adminStore.currentSiteId = 'site-1'

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        admin: {
          users: {
            sendWelcomeEmailUnavailable: 'Mail sending is not implemented yet.'
          }
        }
      }
    }
  })

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })

  currentWrapper = mount(UserCreateDialog, { global: { plugins: [i18n] } })
  return currentWrapper
}

describe('UserCreateDialog send welcome email toggle', () => {
  it('renders disabled with an explanatory caption, and hides the from-site field', async () => {
    mountDialog()
    await flushPromises()

    // Two toggles exist (must-change-password, then send-welcome-email); the second must be
    // disabled while the first stays interactive.
    const toggles = document.body.querySelectorAll('.w-toggle')
    expect(toggles).toHaveLength(2)
    expect(toggles[0].disabled).toBe(false)
    expect(toggles[1].disabled).toBe(true)

    expect(document.body.textContent).toContain('Mail sending is not implemented yet.')

    // Only the groups select should be present -- the "from site" sub-field, gated on the toggle
    // ever being true, must never mount since the toggle can't be turned on.
    expect(document.body.querySelectorAll('.w-select')).toHaveLength(1)
  })
})
