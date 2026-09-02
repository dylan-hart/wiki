import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import SiteCreateDialog from './SiteCreateDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

/*
  `WDialog`'s content lives behind a `<teleport to="body">`, which lands it as a REAL child of
  `document.body`, outside `@vue/test-utils`'s own tracked tree -- unmounting the wrapper is what
  removes it again. Without this, a second test's `document.body.querySelectorAll('input')` would
  also see the first test's now-orphaned dialog, whose elements sort first in document order.
*/
let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
})

/**
 * Regression coverage for #1767: `create()` used to test the resolved 400's `resp?.ok` and read
 * `resp.json()` for the message -- dead once `boot/api.js` throws on every non-2xx status instead of
 * resolving a 400. The `catch` now reads the same message off `err.data` via `apiErrorMessage()`,
 * same as `SiteDeleteDialog` / `SiteActivateDialog`.
 */
function mountDialog() {
  setActivePinia(createPinia())

  const i18n = createTestI18n({
    admin: { sites: { createSuccess: 'Site created.' } }
  })

  currentWrapper = mount(SiteCreateDialog, { global: { plugins: [i18n] } })
  return currentWrapper
}

/*
  `WDialog`'s content lives behind a `<teleport to="body">`, so it renders as a real DOM child of
  `document.body` rather than a descendant of `wrapper.element` -- @vue/test-utils' own `find*` only
  searches the latter, so fields and the confirm button have to be found (and driven, via real DOM
  events) through `document` directly.
*/
async function fillAndSubmit() {
  await flushPromises()
  const [nameInput] = document.body.querySelectorAll('input')
  nameInput.value = 'My Site'
  nameInput.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()

  const buttons = document.body.querySelectorAll('.card-actions button')
  buttons[buttons.length - 1].dispatchEvent(new Event('click', { bubbles: true }))
  await flushPromises()
}

describe('SiteCreateDialog create()', () => {
  it('surfaces the server-provided message on a refused create, not a generic fallback', async () => {
    const err = new Error('Bad Request')
    err.data = { message: 'A site with that hostname already exists.' }
    API_CLIENT.post.mockImplementationOnce(() => {
      throw err
    })

    const wrapper = mountDialog()
    await fillAndSubmit()

    expect(notifyQueue.at(-1)?.message).toBe('A site with that hostname already exists.')
    expect(notifyQueue.at(-1)?.type).toBe('negative')
    expect(wrapper.emitted('ok')).toBeUndefined()
  })

  it('confirms and closes on success', async () => {
    API_CLIENT.post.mockReturnValueOnce({})
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([{ id: 1, title: 'My Site' }])
    })

    const wrapper = mountDialog()
    await fillAndSubmit()

    expect(wrapper.emitted('ok')).toBeTruthy()
    expect(notifyQueue.at(-1)?.type).toBe('positive')
  })
})
