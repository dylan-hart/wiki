import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import WebhookEditDialog from './WebhookEditDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { useAdminStore } from '@/stores/admin'

import { createTestI18n } from '../../test/i18n.js'

/**
 * `POST /_api/hooks/test` lets an admin validate whatever is currently typed into this form -- via a
 * "Send Test Event" button -- before the webhook is ever saved. Covers the three things task 644
 * actually specifies: the button is gated on the same URL validation the form itself enforces, it
 * posts `{ url, authHeader, acceptUntrusted }` (not a hookId) straight from the form fields, and the
 * result (HTTP status or connection error) lands in a `notify()` toast. Exercised for both the
 * create (`hookId: null`) and edit (`hookId` set) forms, since the task requires it stay available
 * in both.
 */

function mountDialog(hookId = null, { sites = [], siteId = null } = {}) {
  setActivePinia(createPinia())
  useAdminStore().sites = sites

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
          siteId,
          state: 'pending',
          lastErrorMessage: null
        })
    })
  }

  const i18n = createTestI18n()

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

/**
 * OpenProject #2356: `WDialog`'s `aria-label` (WP #1617) was never wired up here, so the dialog's
 * `role="dialog"` panel stayed unnamed for assistive tech regardless of which of the two headers
 * (`admin.webhooks.new` / `admin.webhooks.edit`) the `v-if="props.hookId"` template branch shows. The
 * fix mirrors that same branch as a plain ternary on `:aria-label`, so both forms get a real,
 * matching accessible name. Each test unmounts its own wrapper -- `WDialog` teleports into the real
 * `document.body`, which nothing in this file otherwise clears between tests.
 */
describe('WebhookEditDialog accessible name', () => {
  it("gives the panel a non-empty aria-label matching the create form's visible header", async () => {
    const wrapper = mountDialog(null)
    await flushPromises()

    const panel = document.body.querySelector('[role="dialog"]')
    expect(panel).not.toBeNull()
    expect(panel.getAttribute('aria-label')).toBe('admin.webhooks.new')

    wrapper.unmount()
  })

  it("gives the panel a non-empty aria-label matching the edit form's visible header", async () => {
    const wrapper = mountDialog('hook-1')
    await flushPromises()

    const panel = document.body.querySelector('[role="dialog"]')
    expect(panel).not.toBeNull()
    expect(panel.getAttribute('aria-label')).toBe('admin.webhooks.edit')

    wrapper.unmount()
  })
})

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

  it('rejects a scheme that merely starts with "http" (httpfoo://), matching the API (OpenProject #1940)', async () => {
    // -> Placed last in this describe block: `testButton()`'s `document.body` lookup returns the
    //    FIRST matching button across every dialog mounted so far in this file (nothing here calls
    //    `wrapper.unmount()`), so a new mount+assert pair earlier in the block would shift which
    //    stale button the tests after it resolve to. Appending avoids disturbing that ordering.
    mountDialog(null)
    await flushPromises()

    const urlInput = document.body.querySelector('input[placeholder="https://"]')
    urlInput.value = 'httpfoo://x'
    urlInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const btn = testButton()
    expect(btn.disabled).toBe(true)
  })
})

/**
 * Task 1940: `hookUrlValidation` must reject everything `invalidReason()` (`backend/api/hooks.ts`)
 * rejects, so a URL the form accepts is never refused by the API with a 400 the admin sees as a
 * server error.
 */
describe('WebhookEditDialog - url validation', () => {
  it('rejects a URL with a non-http(s) protocol, matching the API', async () => {
    mountDialog(null)
    await flushPromises()

    const urlInput = document.body.querySelector('input[placeholder="https://"]')
    urlInput.value = 'httpfoo://x'
    urlInput.dispatchEvent(new Event('input'))
    await flushPromises()

    const btn = testButton()
    expect(btn.disabled).toBe(true)
  })
})

/**
 * The site picker (task 651) -- sourced off `adminStore.sites` the same way `AdminLayout.vue`'s own
 * site picker and `UserCreateDialog.vue`'s per-site fields are, defaulting to "All sites" (`siteId:
 * null`) so a webhook created without touching the field keeps today's fires-for-every-site
 * behavior.
 */
describe('WebhookEditDialog - site scoping', () => {
  const SITES = [
    { id: 'site-1', title: 'Site One' },
    { id: 'site-2', title: 'Site Two' }
  ]

  it('defaults to "All sites" (siteId null) on the create form', async () => {
    const wrapper = mountDialog(null, { sites: SITES })
    await flushPromises()

    expect(wrapper.vm.state.hook.siteId).toBe(null)
  })

  it('offers "All sites" plus every known site as options', async () => {
    const wrapper = mountDialog(null, { sites: SITES })
    await flushPromises()

    const optionIds = wrapper.vm.siteOptions.map((opt) => opt.id)
    expect(optionIds).toEqual([null, 'site-1', 'site-2'])
  })

  it("loads a persisted webhook's siteId on the edit form", async () => {
    const wrapper = mountDialog('hook-1', { sites: SITES, siteId: 'site-1' })
    await flushPromises()

    expect(wrapper.vm.state.hook.siteId).toBe('site-1')
  })

  it('sends the selected siteId as part of create', async () => {
    const wrapper = mountDialog(null, { sites: SITES })
    await flushPromises()
    wrapper.vm.state.hook.name = 'My Hook'
    wrapper.vm.state.hook.events = ['page:create']
    wrapper.vm.state.hook.url = 'https://example.com/hook'
    wrapper.vm.state.hook.siteId = 'site-2'
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, id: 'new-hook' })
    })

    await wrapper.vm.create()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'hooks',
      expect.objectContaining({ json: expect.objectContaining({ siteId: 'site-2' }) })
    )
  })

  it('sends siteId: null when saving with "All sites" selected', async () => {
    const wrapper = mountDialog('hook-1', { sites: SITES, siteId: 'site-1' })
    await flushPromises()
    wrapper.vm.state.hook.siteId = null
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true })
    })

    await wrapper.vm.save()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      'hooks/hook-1',
      expect.objectContaining({ json: expect.objectContaining({ siteId: null }) })
    )
  })
})
