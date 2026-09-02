import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import WebhookHistoryDialog from './WebhookHistoryDialog.vue'
import { useUserStore } from '@/stores/user'

import { mountWithApp } from '../../test/mount.js'

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

  return mountWithApp(WebhookHistoryDialog, {
    props: {
      hook: { id: 'hook-1', name: 'My Webhook' }
    },
    messages: { common: { datetime: '{date} at {time}' } },
    // -> Opts out of `mountWithApp`'s default `teleport: true` stub: `w-dialog` really teleports
    //    its body to `document.body`, which is where this suite asserts.
    stubs: {}
  }).wrapper
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

  /** WP 2082: `humanizeDate` used to render a hardcoded browser-locale/timezone string directly; it
   *  now delegates to the shared `humanizeDateWithSeconds` helper (`helpers/datetime.js`), which
   *  routes through `userStore.formatDateTime`, so a stored timezone changes what shows. */
  it("renders a delivery's startedAt through the shared date helper, so a stored timezone changes it", async () => {
    const wrapper = mountDialog([
      {
        event: 'page:create',
        state: 'completed',
        attempt: 1,
        maxRetries: 3,
        lastErrorMessage: null,
        startedAt: '2026-08-01T23:30:15.000Z',
        completedAt: '2026-08-01T23:30:16.000Z'
      }
    ])
    const userStore = useUserStore()
    userStore.timezone = 'Pacific/Kiritimati'
    userStore.dateFormat = 'YYYY-MM-DD'
    userStore.timeFormat = '24h'
    await flushPromises()

    expect(document.body.textContent).toContain('2026-08-02 at 13:30:15')
  })
})
