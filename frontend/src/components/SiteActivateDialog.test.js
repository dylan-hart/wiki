import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import SiteActivateDialog from './SiteActivateDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

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
 * Regression test for confirm()'s error handling. The old code chained `.json()` straight off the
 * request (`API_CLIENT.put(...).json()`), which -- because `boot/api.js` sets
 * `throwHttpErrors: (statusNumber) => statusNumber > 400` -- throws a ky `HTTPError` for any status
 * above 400 before ever reaching a place that could parse the body, and `catch (err)` then read ky's
 * generic `err.message` rather than the server's actual reason. This matters as soon as a "cannot
 * disable the last enabled site" guard exists on `PUT /_api/sites/:siteId` (a later task), the same
 * way the "last site" guard matters for `SiteDeleteDialog`.
 */
function httpError(message) {
  return Object.assign(new Error('Request failed with status code 409: PUT /sites/1'), {
    name: 'HTTPError',
    data: { message }
  })
}

function mountDialog({
  site = { id: 1, title: 'Test Site', isEnabled: true },
  targetState = false
} = {}) {
  setActivePinia(createPinia())

  const i18n = createTestI18n({
    admin: { sites: { updateSuccess: 'Site updated.' } }
  })

  currentWrapper = mount(SiteActivateDialog, {
    props: { site, targetState },
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
async function clickConfirm() {
  await flushPromises()
  const buttons = document.body.querySelectorAll('.card-actions button')
  buttons[buttons.length - 1].dispatchEvent(new Event('click', { bubbles: true }))
  await flushPromises()
}

describe('SiteActivateDialog confirm()', () => {
  it("surfaces the server-provided message from a 409, not ky's generic text", async () => {
    API_CLIENT.put.mockImplementationOnce(() => {
      throw httpError('You cannot disable the last enabled site.')
    })

    const wrapper = mountDialog()
    await clickConfirm()

    expect(notifyQueue.at(-1)?.message).toBe('You cannot disable the last enabled site.')
    expect(notifyQueue.at(-1)?.type).toBe('negative')
    expect(wrapper.emitted('ok')).toBeUndefined()
  })

  it('confirms and closes on success', async () => {
    API_CLIENT.put.mockReturnValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) })

    const wrapper = mountDialog()
    await clickConfirm()

    expect(wrapper.emitted('ok')).toBeTruthy()
    expect(notifyQueue.at(-1)?.type).toBe('positive')
  })
})
