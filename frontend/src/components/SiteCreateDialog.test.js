import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import SiteCreateDialog from './SiteCreateDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'

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
 * Audit-and-align test for create(): unlike `SiteDeleteDialog` / `SiteActivateDialog`, this endpoint's
 * failures are all <=400 today, so ky's `throwHttpErrors: (statusNumber) => statusNumber > 400` never
 * throws here. But `create()` used to read `err.message` in its `catch`, same as the other two, so it
 * would have gone straight to ky's generic text the moment this endpoint grew a >400 response. Routing
 * it through `apiErrorMessage()` keeps it correct either way.
 */
function mountDialog() {
  setActivePinia(createPinia())

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        admin: { sites: { createSuccess: 'Site created.' } }
      }
    }
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
  it('surfaces the server-provided message on a <=400 failure, not a generic fallback', async () => {
    API_CLIENT.post.mockReturnValueOnce({
      ok: false,
      json: () => Promise.resolve({ message: 'A site with that hostname already exists.' })
    })

    const wrapper = mountDialog()
    await fillAndSubmit()

    expect(notifyQueue.at(-1)?.message).toBe('A site with that hostname already exists.')
    expect(notifyQueue.at(-1)?.type).toBe('negative')
    expect(wrapper.emitted('ok')).toBeUndefined()
  })

  it('confirms and closes on success', async () => {
    API_CLIENT.post.mockReturnValueOnce({ ok: true })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([{ id: 1, title: 'My Site' }])
    })

    const wrapper = mountDialog()
    await fillAndSubmit()

    expect(wrapper.emitted('ok')).toBeTruthy()
    expect(notifyQueue.at(-1)?.type).toBe('positive')
  })
})
