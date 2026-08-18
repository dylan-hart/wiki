import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import WebhookEditDialog from './WebhookEditDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'

/**
 * `POST /_api/hooks/test` lets an admin validate whatever is currently typed into this form -- via a
 * "Send Test Event" button -- before the webhook is ever saved. Covers the three things task 644
 * actually specifies: the button is gated on the same URL validation the form itself enforces, it
 * posts `{ url, authHeader, acceptUntrusted }` (not a hookId) straight from the form fields, and the
 * result (HTTP status or connection error) lands in a `notify()` toast. Exercised for both the
 * create (`hookId: null`) and edit (`hookId` set) forms, since the task requires it stay available
 * in both.
 */

function mountDialog(hookId = null) {
  // -> `onMounted` calls `fetchEmittedEvents()` (hits `hooks/events`) before `fetchHook()` (hits
  //    `hooks/:id`), so the stubbed `get` calls have to be queued in that same order.
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })
  if (hookId) {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: hookId,
          name: 'My Webhook',
          events: ['page:create'],
          url: 'https://example.com/hook',
          includeMetadata: true,
          includeContent: false,
          acceptUntrusted: false,
          authHeader: null,
          state: 'pending',
          lastErrorMessage: null
        })
    })
  }

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(WebhookEditDialog, {
    props: { hookId },
    global: { plugins: [i18n] }
  })
}

/** The "Send Test Event" button -- found by its i18n key, since the test i18n has no messages. */
function testButton() {
  return Array.from(document.body.querySelectorAll('button')).find((btn) =>
    btn.textContent.includes('admin.webhooks.testSend')
  )
}

describe('WebhookEditDialog - send test event', () => {
  it('disables the button while the url fails validation, on the create form', async () => {
    mountDialog(null)
    await flushPromises()

    const btn = testButton()
    expect(btn).toBeTruthy()
    expect(btn.disabled).toBe(true)
  })

  it('enables the button once a valid url is typed, on the create form', async () => {
    mountDialog(null)
    await flushPromises()

    // -> `w-dialog` teleports its content to `document.body`, so the input has to be found and
    //    driven there rather than through the mount wrapper's own element tree. `aria-label` falls
    //    through to `<w-input>`'s wrapper div rather than the `<input>` itself, so the URL field is
    //    found by its placeholder instead.
    const urlInput = document.body.querySelector('input[placeholder="https://"]')
    urlInput.value = 'https://example.com/hook'
    urlInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const btn = testButton()
    expect(btn.disabled).toBe(false)
  })

  it('is enabled on the edit form once the persisted url has loaded', async () => {
    mountDialog('hook-1')
    await flushPromises()

    const btn = testButton()
    expect(btn.disabled).toBe(false)
  })

  it('posts url/authHeader/acceptUntrusted (not a hookId) and shows a positive toast on success', async () => {
    notifyQueue.splice(0, notifyQueue.length)
    mountDialog('hook-1')
    await flushPromises()

    const postJsonMock = {
      json: () =>
        Promise.resolve({
          ok: true,
          statusCode: 200,
          message: 'The endpoint answered successfully.'
        })
    }
    API_CLIENT.post.mockReturnValueOnce(postJsonMock)

    testButton().click()
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith('hooks/test', {
      json: {
        url: 'https://example.com/hook',
        authHeader: undefined,
        acceptUntrusted: false
      }
    })
    expect(
      notifyQueue.some(
        (n) => n.type === 'positive' && n.message === 'The endpoint answered successfully.'
      )
    ).toBe(true)
  })

  it('shows a negative toast with the connection error when the request fails', async () => {
    notifyQueue.splice(0, notifyQueue.length)
    mountDialog('hook-1')
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: false,
          statusCode: 0,
          message: 'The endpoint did not respond within 15s.'
        })
    })

    testButton().click()
    await flushPromises()

    expect(
      notifyQueue.some(
        (n) => n.type === 'negative' && n.message === 'The endpoint did not respond within 15s.'
      )
    ).toBe(true)
  })
})
