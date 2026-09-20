import { describe, expect, it } from 'vitest'

import AdminWebhooks from './AdminWebhooks.vue'
import { queue as notifyQueue } from '@/composables/notify'

import { mountWithApp } from '../../test/mount.js'

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
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([HOOK]) })

  const { wrapper } = mountWithApp(AdminWebhooks)
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
