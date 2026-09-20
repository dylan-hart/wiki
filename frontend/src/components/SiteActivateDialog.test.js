import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import SiteActivateDialog from './SiteActivateDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

/*
  `WDialog` teleports its content to `document.body`, outside `@vue/test-utils`'s own tracked tree,
  so unmounting the wrapper is what removes it -- otherwise each test sees the previous dialog too.
*/
let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
})

/**
 * Shaped like what ky throws above a 400: the server's reason is in the already-parsed `data`, not
 * in `message`, so a handler reading `err.message` would report ky's generic text instead.
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
  Teleported content is not a descendant of `wrapper.element`, which is all @vue/test-utils' `find*`
  searches, so the confirm button is reached -- and clicked with a real DOM event -- via `document`.
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
