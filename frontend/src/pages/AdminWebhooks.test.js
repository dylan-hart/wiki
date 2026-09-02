import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminWebhooks from './AdminWebhooks.vue'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

/**
 * The per-row "Send Test Event" button re-validates a SAVED webhook without opening the edit
 * dialog, via the same `POST /_api/hooks/test` the edit dialog itself calls — task 644 requires it
 * pass the persisted hook's own `url`/`authHeader`/`acceptUntrusted` through that same body shape
 * rather than a second, hookId-based endpoint.
 */

const HOOK = {
  id: 'hook-1',
  name: 'My Webhook',
  url: 'https://example.com/hook',
  authHeader: 'Bearer abc123',
  acceptUntrusted: true,
  state: 'success',
  lastErrorMessage: null
}

async function mountPage() {
  setActivePinia(createPinia())

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([HOOK]) })

  const i18n = createTestI18n()

  const wrapper = mount(AdminWebhooks, {
    global: { plugins: [i18n] }
  })
  await Promise.resolve()
  await Promise.resolve()

  return wrapper
}

describe('AdminWebhooks - per-row send test event', () => {
  it('posts the saved url/authHeader/acceptUntrusted through the same test endpoint', async () => {
    notifyQueue.splice(0, notifyQueue.length)
    const wrapper = await mountPage()

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          statusCode: 200,
          message: 'The endpoint answered successfully.'
        })
    })

    const testBtn = wrapper.find('[aria-label="admin.webhooks.testSend"]')
    expect(testBtn.exists()).toBe(true)
    await testBtn.trigger('click')
    await Promise.resolve()
    await Promise.resolve()

    expect(API_CLIENT.post).toHaveBeenCalledWith('hooks/test', {
      json: {
        url: 'https://example.com/hook',
        authHeader: 'Bearer abc123',
        acceptUntrusted: true
      }
    })
    expect(
      notifyQueue.some(
        (n) => n.type === 'positive' && n.message === 'The endpoint answered successfully.'
      )
    ).toBe(true)
  })

  it('shows a negative toast when the endpoint reports failure', async () => {
    notifyQueue.splice(0, notifyQueue.length)
    const wrapper = await mountPage()

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: false,
          statusCode: 0,
          message: 'The endpoint did not respond within 15s.'
        })
    })

    await wrapper.find('[aria-label="admin.webhooks.testSend"]').trigger('click')
    await Promise.resolve()
    await Promise.resolve()

    expect(
      notifyQueue.some(
        (n) => n.type === 'negative' && n.message === 'The endpoint did not respond within 15s.'
      )
    ).toBe(true)
  })
})
