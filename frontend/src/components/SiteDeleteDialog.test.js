import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import SiteDeleteDialog from './SiteDeleteDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'

/*
  `WDialog`'s content lives behind a `<teleport to="body">`, which lands it as a REAL child of
  `document.body`, outside `@vue/test-utils`'s own tracked tree -- unmounting the wrapper is what
  removes it again, keeping each test's dialog the only one present.
*/
let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
})

/**
 * Regression test for confirm()'s error handling. `boot/api.js` configures `ky` with
 * `throwHttpErrors: (statusNumber) => statusNumber > 400`, so both 409s from
 * `DELETE /_api/sites/:siteId` (the "last site" guard and the "still holds content" conflict) throw
 * a ky `HTTPError` -- which parses the response body into `err.data` before throwing -- straight into
 * `catch (err)`. The old code read `err.message` there, which is ky's generic status-line text
 * ("Request failed with status code 409: ..."), never the server's actual reason, so neither guard's
 * message ever reached the admin. `confirm()` must read the body via `apiErrorMessage()` instead.
 */
function httpError(message) {
  // -> Mirrors what a real ky `HTTPError` looks like once thrown for a >400 status: a `.data`
  //    property holding the pre-parsed JSON body, and a generic `.message` that must NOT win.
  return Object.assign(new Error('Request failed with status code 409: DELETE /sites/1'), {
    name: 'HTTPError',
    data: { message }
  })
}

function mountDialog(site = { id: 1, title: 'Test Site' }) {
  setActivePinia(createPinia())

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        admin: { sites: { deleteSuccess: 'Site deleted.' } }
      }
    }
  })

  currentWrapper = mount(SiteDeleteDialog, {
    props: { site },
    global: { plugins: [i18n] }
  })
  return currentWrapper
}

/*
  `WDialog`'s content lives behind a `<teleport to="body">`, so it renders as a real DOM child of
  `document.body` rather than a descendant of `wrapper.element` -- @vue/test-utils' own `find*` only
  searches the latter, so the confirm button has to be found (and triggered, via a real DOM event)
  through `document` directly.
*/
async function clickDelete() {
  await flushPromises()
  const buttons = document.body.querySelectorAll('.card-actions button')
  buttons[buttons.length - 1].dispatchEvent(new Event('click', { bubbles: true }))
  await flushPromises()
}

describe('SiteDeleteDialog confirm()', () => {
  it('surfaces the server-provided message from the "last site" 409, not ky\'s generic text', async () => {
    API_CLIENT.delete.mockImplementationOnce(() => {
      throw httpError('You cannot delete the last remaining site.')
    })

    const wrapper = mountDialog()
    await clickDelete()

    expect(notifyQueue.at(-1)?.message).toBe('You cannot delete the last remaining site.')
    expect(notifyQueue.at(-1)?.type).toBe('negative')
    expect(wrapper.emitted('ok')).toBeUndefined()
  })

  it('surfaces the distinct "still holds content" 409 message', async () => {
    API_CLIENT.delete.mockImplementationOnce(() => {
      throw httpError('This site still holds content and cannot be deleted.')
    })

    const wrapper = mountDialog()
    await clickDelete()

    expect(notifyQueue.at(-1)?.message).toBe('This site still holds content and cannot be deleted.')
  })

  it('confirms and closes on success', async () => {
    API_CLIENT.delete.mockReturnValueOnce({ ok: true })

    const wrapper = mountDialog()
    await clickDelete()

    expect(wrapper.emitted('ok')).toBeTruthy()
    expect(notifyQueue.at(-1)?.type).toBe('positive')
  })
})
