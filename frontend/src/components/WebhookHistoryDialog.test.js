import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import WebhookHistoryDialog from './WebhookHistoryDialog.vue'
import { useUserStore } from '@/stores/user'

import { mountWithApp } from '../../test/mount.js'

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
    // -> Opts out of the default `teleport: true` stub: `w-dialog` really teleports its body to
    //    `document.body`, which is where this suite asserts.
    stubs: {}
  }).wrapper
}

describe('WebhookHistoryDialog', () => {
  it('fetches the deliveries for the given hook', async () => {
    mountDialog([])
    await Promise.resolve()

    expect(API_CLIENT.get).toHaveBeenCalledWith('hooks/hook-1/deliveries')
  })

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
    const icon = document.body.querySelector('[data-icon="tabler:circle-check"]')
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
    const icon = document.body.querySelector('[data-icon="tabler:alert-triangle"]')
    expect(icon).not.toBeNull()
    expect(icon.classList.contains('text-negative')).toBe(true)
  })

  it('shows an empty state when there are no deliveries', async () => {
    mountDialog([])
    await flushPromises()

    expect(document.body.textContent).toContain('admin.webhooks.historyNone')
  })

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
