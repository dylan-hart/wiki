import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminReplication from './AdminReplication.vue'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

/**
 * The instance-level replication settings panel (OpenProject #2437/#2491). This is a plain
 * `useAdminSettings` settings form -- load-then-save -- following the same shape `AdminMail.vue`'s
 * own `save()` does (a custom PUT rather than the composable's default `save()`, since the payload
 * needs its own field mapping). The bearerToken masking round trip itself is backend behavior,
 * covered in `backend/api/replication.test.ts`; what belongs here is that this page sends exactly
 * what the user typed to `PUT /_api/replication/config` and reports what the server answers.
 */

async function mountAdminReplication() {
  setActivePinia(createPinia())

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n({
    admin: {
      replication: {
        title: 'Replication',
        sourceUrl: 'Source Instance URL',
        bearerToken: 'Bearer Token',
        cronSchedule: 'Cron Schedule',
        cronScheduleInvalid: 'This is not a valid cron expression.',
        cronScheduleTooFrequent: 'The cron schedule may not fire more often than once per hour.',
        enabled: 'Enabled',
        saveSuccess: 'Replication configuration saved successfully.'
      }
    }
  })

  // -> The unrelated `GET replication/config` call `onMounted` fires resolves to `undefined` by
  //    default (`createApiClientStub()`), which `load()` already handles as a failure -- nothing
  //    under test here reads `state.config` before saving, so it is left alone rather than stubbed.
  const wrapper = mount(AdminReplication, {
    global: {
      plugins: [router, i18n]
    }
  })
  await wrapper.vm.$nextTick()

  // -> Drain the negative toast the failed `GET` above queued, so a test only sees notifications its
  //    own action produced.
  notifyQueue.splice(0, notifyQueue.length)

  const applyButton = wrapper
    .findAll('button')
    .find((btn) => btn.text().includes('common.actions.apply'))

  return { wrapper, applyButton }
}

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
})

describe('AdminReplication save', () => {
  it('sends the source URL, bearer token, cron schedule and enabled flag to PUT /replication/config', async () => {
    API_CLIENT.put.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ ok: true, message: 'Replication configuration updated successfully.' })
    })

    const { wrapper, applyButton } = await mountAdminReplication()

    const sourceUrlField = wrapper.get('input[aria-label="Source Instance URL"]')
    const bearerTokenField = wrapper.get('input[aria-label="Bearer Token"]')
    const cronField = wrapper.get('input[aria-label="Cron Schedule"]')
    await sourceUrlField.setValue('https://prod.example.com')
    await bearerTokenField.setValue('a-real-token')
    await cronField.setValue('0 0 * * 0')

    await applyButton.trigger('click')
    await vi.waitFor(() => expect(API_CLIENT.put).toHaveBeenCalled())

    expect(API_CLIENT.put).toHaveBeenCalledWith('replication/config', {
      json: {
        isEnabled: false,
        sourceUrl: 'https://prod.example.com',
        bearerToken: 'a-real-token',
        cronSchedule: '0 0 * * 0'
      }
    })
    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(true)
  })

  it('shows the backend validation message when the server rejects the config', async () => {
    const err = new Error('Bad Request')
    err.data = {
      ok: false,
      message: 'A bearer token is required to enable replication.'
    }
    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.reject(err)
    })

    const { applyButton } = await mountAdminReplication()
    await applyButton.trigger('click')
    await vi.waitFor(() => expect(API_CLIENT.put).toHaveBeenCalled())

    const negative = notifyQueue.find((n) => n.type === 'negative')
    expect(negative?.message).toMatch(/bearer token is required/i)
  })

  it('does not send a second request while a save is already in flight', async () => {
    let resolvePut
    API_CLIENT.put.mockReturnValueOnce({
      json: () =>
        new Promise((resolve) => {
          resolvePut = resolve
        })
    })

    const { applyButton } = await mountAdminReplication()
    await applyButton.trigger('click')
    await applyButton.trigger('click')

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
    resolvePut({ ok: true, message: 'Replication configuration updated successfully.' })
  })
})

/**
 * Client-side mirror of `backend/api/replication.ts#validateCronSchedule()`'s minimum-interval floor
 * (OpenProject #2509) -- the server remains the authority, this is immediate feedback only.
 */
describe('AdminReplication cronSchedule validation', () => {
  it('shows an error for a cron expression that fires more often than once an hour', async () => {
    const { wrapper } = await mountAdminReplication()

    const cronField = wrapper.get('input[aria-label="Cron Schedule"]')
    await cronField.setValue('* * * * *')
    await cronField.trigger('blur')
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain(
      'The cron schedule may not fire more often than once per hour.'
    )
  })

  it('shows an error for an expression that does not parse as cron', async () => {
    const { wrapper } = await mountAdminReplication()

    const cronField = wrapper.get('input[aria-label="Cron Schedule"]')
    await cronField.setValue('not a cron expression')
    await cronField.trigger('blur')
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('This is not a valid cron expression.')
  })

  it('shows no error for a cron expression that fires exactly once an hour', async () => {
    const { wrapper } = await mountAdminReplication()

    const cronField = wrapper.get('input[aria-label="Cron Schedule"]')
    await cronField.setValue('0 * * * *')
    await cronField.trigger('blur')
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('once per hour')
    expect(wrapper.text()).not.toContain('valid cron expression')
  })
})
