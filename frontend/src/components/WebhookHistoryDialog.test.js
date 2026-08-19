import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import WebhookHistoryDialog from './WebhookHistoryDialog.vue'

/**
 * `getDeliveryHistory()`'s API surface — a status icon/color per row plus the error message on
 * failed rows, reusing the same success/error color treatment `AdminWebhooks.vue` uses for a hook's
 * own state. The dialog fetches on mount via `API_CLIENT`, stubbed here per `test/setup.js`.
 */
function mountDialog(deliveries, { total } = {}) {
  API_CLIENT.get.mockReturnValueOnce({
    json: () =>
      Promise.resolve({
        total: total ?? deliveries.length,
        limit: 100,
        deliveries
      })
  })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(WebhookHistoryDialog, {
    props: {
      hook: { id: 'hook-1', name: 'My Webhook' }
    },
    global: {
      plugins: [i18n]
    }
  })
}

describe('WebhookHistoryDialog', () => {
  it('fetches the deliveries for the given hook', async () => {
    mountDialog([])
    await Promise.resolve()

    expect(API_CLIENT.get).toHaveBeenCalledWith('hooks/hook-1/deliveries')
  })

  // -> `w-dialog` teleports its content to `document.body`, so it never appears under `wrapper`'s
  //    own element — asserted against `document.body` instead, as any teleported overlay must be.
  it('renders a positive icon and no error message for a completed delivery', async () => {
    mountDialog([
      {
        event: 'page:create',
        state: 'completed',
        attempt: 1,
        maxRetries: 3,
        lastErrorMessage: null,
        startedAt: '2026-08-01T12:00:00.000Z',
        completedAt: '2026-08-01T12:00:01.000Z'
      }
    ])
    await flushPromises()

    expect(document.body.textContent).toContain('page:create')
    expect(document.body.querySelector('.text-negative')).toBeNull()
    const icon = document.body.querySelector('[data-icon="la:check-circle"]')
    expect(icon).not.toBeNull()
    expect(icon.classList.contains('text-positive')).toBe(true)
  })

  it('renders a negative icon and the error message for a failed delivery', async () => {
    mountDialog([
      {
        event: 'page:edit',
        state: 'failed',
        attempt: 2,
        maxRetries: 3,
        lastErrorMessage: 'The endpoint answered with HTTP 500.',
        startedAt: '2026-08-01T12:00:00.000Z',
        completedAt: '2026-08-01T12:00:01.000Z'
      }
    ])
    await flushPromises()

    expect(document.body.textContent).toContain('page:edit')
    expect(document.body.textContent).toContain('The endpoint answered with HTTP 500.')
    const icon = document.body.querySelector('[data-icon="la:exclamation-triangle"]')
    expect(icon).not.toBeNull()
    expect(icon.classList.contains('text-negative')).toBe(true)
  })

  it('shows an empty state when there are no deliveries', async () => {
    mountDialog([])
    await flushPromises()

    expect(document.body.textContent).toContain('admin.webhooks.historyNone')
  })
})
