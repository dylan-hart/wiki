import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import SiteCreateDialog from './SiteCreateDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

/*
  `WDialog` teleports its content to `document.body`, outside `@vue/test-utils`'s own tracked tree,
  so unmounting the wrapper is what removes it. Without this, a later test's
  `document.body.querySelectorAll('input')` also sees the earlier dialog, which sorts first.
*/
let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
})

function mountDialog() {
  setActivePinia(createPinia())

  const i18n = createTestI18n({
    admin: { sites: { createSuccess: 'Site created.' } }
  })

  currentWrapper = mount(SiteCreateDialog, { global: { plugins: [i18n] } })
  return currentWrapper
}

/*
  Teleported content is not a descendant of `wrapper.element`, which is all @vue/test-utils' `find*`
  searches, so the fields and the confirm button are reached -- and driven with real DOM events --
  via `document`.
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
