import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminMail from './AdminMail.vue'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

async function mountAdminMail() {
  setActivePinia(createPinia())

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n({
    admin: {
      mail: {
        testRecipient: 'Recipient Email Address',
        testSend: 'Send Email',
        sendTestSuccess: 'A test email was sent successfully.'
      }
    }
  })

  // -> `onMounted`'s unrelated `GET mail/config` is left unstubbed: nothing here reads
  //    `state.config`, and `load()` already handles the default stub's `undefined` as a failure
  const wrapper = mount(AdminMail, {
    global: {
      plugins: [router, i18n]
    }
  })
  await wrapper.vm.$nextTick()

  // -> That failed load queues its own negative toast; drained so a test sees only what its own
  //    action produced
  notifyQueue.splice(0, notifyQueue.length)

  const recipientField = wrapper.get('input[aria-label="Recipient Email Address"]')
  const sendButton = wrapper.findAll('button').find((btn) => btn.text().includes('Send Email'))

  return { wrapper, recipientField, sendButton }
}

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
})

describe('AdminMail sendTest', () => {
  it('posts the recipient to /mail/test and shows a success toast', async () => {
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, message: 'Test email sent successfully.' })
    })

    const { recipientField, sendButton } = await mountAdminMail()
    await recipientField.setValue('ada@example.com')
    await sendButton.trigger('click')
    await vi.waitFor(() => expect(API_CLIENT.post).toHaveBeenCalled())

    expect(API_CLIENT.post).toHaveBeenCalledWith('mail/test', {
      json: { recipientEmail: 'ada@example.com' }
    })
    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
  })

  it('shows the backend error message when mail is not configured', async () => {
    // -> ky throws on a 400 like any other non-2xx status, having parsed the body onto `err.data`
    const err = new Error('Bad Request')
    err.data = {
      ok: false,
      message: 'Mail is not configured. Set an SMTP host before sending a test email.'
    }
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.reject(err)
    })

    const { recipientField, sendButton } = await mountAdminMail()
    await recipientField.setValue('ada@example.com')
    await sendButton.trigger('click')
    await vi.waitFor(() => expect(API_CLIENT.post).toHaveBeenCalled())

    const negative = notifyQueue.find((n) => n.type === 'negative')
    expect(negative?.message).toMatch(/not configured/i)
  })

  it('shows the backend error message, not a generic one, when the request throws (e.g. a 502)', async () => {
    const err = new Error('Request failed with status code 502')
    err.data = {
      ok: false,
      error: 'Bad Gateway',
      statusCode: 502,
      message:
        'Could not connect to the SMTP server. Check the host and port under Mail Configuration.'
    }
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.reject(err)
    })

    const { recipientField, sendButton } = await mountAdminMail()
    await recipientField.setValue('ada@example.com')
    await sendButton.trigger('click')
    await vi.waitFor(() => expect(API_CLIENT.post).toHaveBeenCalled())

    const negative = notifyQueue.find((n) => n.type === 'negative')
    expect(negative?.message).toMatch(/could not connect to the smtp server/i)
  })
})

/**
 * The seeded `defaultBaseURL` is blank and the example host is only a placeholder, so a fresh
 * instance cannot mail anyone a link to a host nobody controls.
 */
describe('AdminMail defaultBaseURL placeholder (OpenProject #3386)', () => {
  it('shows https://wiki.example.com as a placeholder, not a value', async () => {
    setActivePinia(createPinia())
    const router = await createTestRouter(['/'])
    const i18n = createTestI18n({
      admin: { mail: { defaultBaseURL: 'Default Base URL' } }
    })

    const wrapper = mount(AdminMail, {
      global: { plugins: [router, i18n] }
    })
    await wrapper.vm.$nextTick()

    const field = wrapper.get('input[aria-label="Default Base URL"]')
    expect(field.attributes('placeholder')).toBe('https://wiki.example.com')
    expect(field.element.value).toBe('')
  })
})
