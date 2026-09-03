import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminMail from './AdminMail.vue'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

/**
 * `sendTest()` used to be a stub that always showed a warning notification (the backend had no SMTP
 * transport yet). It now calls `POST /_api/mail/test` for real and reflects whatever the backend
 * answers -- this covers both branches, driven through the actual DOM (the recipient field + the
 * "Send Email" button), not by reaching into component internals.
 */

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

  // -> The unrelated `GET mail/config` call `onMounted` fires resolves to `undefined` by default
  //    (`createApiClientStub()`), which `load()` already handles as a failure -- nothing under test
  //    here reads `state.config`, so it is left alone rather than stubbed.
  const wrapper = mount(AdminMail, {
    global: {
      plugins: [router, i18n]
      // -> Registered globally by `boot/components.js`, not by the `sharedComponents` map
      //    `test/setup.js` installs -- stubbed here rather than widening the shared harness for a
      //    component this test never asserts against.
    }
  })
  await wrapper.vm.$nextTick()

  // -> The unrelated `GET mail/config` call from `onMounted` fails against the default API_CLIENT
  //    stub and queues its own negative toast -- drained here so a test only sees notifications its
  //    own action produced.
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
    // -> Regression coverage for #1767: ky throws for a 400 the same as any other non-2xx status
    //    (see `boot/api.js`), and parses the body onto `err.data` before throwing.
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
    // -> ky throws for every non-2xx status (see `boot/api.js`), and parses the body onto `err.data`
    //    before throwing (see `helpers/apiError.js`) -- this is what a 502/422/500 from `mail/test`
    //    looks like on the wire, same as the 400 case above.
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
