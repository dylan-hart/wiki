import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import SiteDeleteDialog from './SiteDeleteDialog.vue'
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
 * Mirrors a real ky `HTTPError` above a 400: the server's reason is in the pre-parsed `data`, and
 * the generic status-line `message` must not win.
 */
function httpError(message) {
  return Object.assign(new Error('Request failed with status code 409: DELETE /sites/1'), {
    name: 'HTTPError',
    data: { message }
  })
}

function mountDialog(site = { id: 1, title: 'Test Site' }) {
  setActivePinia(createPinia())

  const i18n = createTestI18n({
    admin: { sites: { deleteSuccess: 'Site deleted.' } }
  })

  currentWrapper = mount(SiteDeleteDialog, {
    props: { site },
    global: { plugins: [i18n] }
  })
  return currentWrapper
}

/*
  Teleported content is not a descendant of `wrapper.element`, which is all @vue/test-utils' `find*`
  searches, so the confirm button is reached -- and clicked with a real DOM event -- via `document`.
*/
function deleteButton() {
  const buttons = document.body.querySelectorAll('.card-actions button')
  return buttons[buttons.length - 1]
}

async function clickDelete() {
  await flushPromises()
  deleteButton().dispatchEvent(new Event('click', { bubbles: true }))
  await flushPromises()
}

async function typeConfirmText(text) {
  await flushPromises()
  const input = document.body.querySelector('.w-input input')
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

describe('SiteDeleteDialog accessible name', () => {
  it("gives the panel a non-empty aria-label matching the visible header's text", async () => {
    mountDialog()
    await flushPromises()

    const panel = document.body.querySelector('[role="dialog"]')
    expect(panel).not.toBeNull()
    expect(panel.getAttribute('aria-label')).toBe('admin.sites.delete')
    expect(panel.textContent).toContain('admin.sites.delete')
  })
})

describe('SiteDeleteDialog confirm()', () => {
  it('surfaces the server-provided message from the "last site" 409, not ky\'s generic text', async () => {
    API_CLIENT.delete.mockImplementationOnce(() => {
      throw httpError('You cannot delete the last remaining site.')
    })

    const wrapper = mountDialog()
    await typeConfirmText('Test Site')
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
    await typeConfirmText('Test Site')
    await clickDelete()

    expect(notifyQueue.at(-1)?.message).toBe('This site still holds content and cannot be deleted.')
  })

  it('confirms and closes on success once the site title is typed exactly', async () => {
    API_CLIENT.delete.mockReturnValueOnce({ ok: true })

    const wrapper = mountDialog()
    await typeConfirmText('Test Site')
    await clickDelete()

    expect(wrapper.emitted('ok')).toBeTruthy()
    expect(notifyQueue.at(-1)?.type).toBe('positive')
  })

  it('keeps the Delete button disabled until the typed value matches the site title exactly', async () => {
    mountDialog()
    await flushPromises()

    expect(deleteButton().disabled).toBe(true)

    await typeConfirmText('Test Sit')
    expect(deleteButton().disabled).toBe(true)

    await typeConfirmText('test site')
    expect(deleteButton().disabled).toBe(true)

    await typeConfirmText('Test Site')
    expect(deleteButton().disabled).toBe(false)
  })

  it('does not call the API or emit confirm while the typed value does not match', async () => {
    const wrapper = mountDialog()
    await typeConfirmText('not the site title')
    await clickDelete()

    expect(API_CLIENT.delete).not.toHaveBeenCalled()
    expect(wrapper.emitted('ok')).toBeUndefined()
  })
})
