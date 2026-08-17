import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AuthLoginPanel from './AuthLoginPanel.vue'
import { useSiteStore } from '@/stores/site'

/**
 * Regression coverage for the login-time recovery-code toggle (task 428): switching the `tfa`
 * screen from the 6-digit authenticator field to a recovery-code field, and sending whichever one
 * is active through the same `PUT sites/:siteId/auth/tfa` call the backend already tells apart by
 * shape (task 427).
 */

const LOCAL_STRATEGY = {
  id: 'strat-1',
  activeStrategy: {
    displayName: 'Local',
    registration: false,
    allowForgotPassword: false,
    strategy: {
      key: 'local',
      useForm: true,
      usernameType: 'email',
      icon: 'local.svg'
    }
  }
}

async function mountAtTfaScreen() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([LOCAL_STRATEGY]) })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
  const wrapper = mount(AuthLoginPanel, {
    global: { plugins: [i18n] }
  })
  await flushPromises()

  const inputs = wrapper.findAll('input')
  await inputs[0].setValue('reader@example.com')
  await inputs[1].setValue('correct horse battery staple')

  API_CLIENT.put.mockReturnValueOnce({
    json: () =>
      Promise.resolve({
        ok: true,
        nextAction: 'provideTfa',
        continuationToken: 'ct-1'
      })
  })
  await wrapper.find('form').trigger('submit')
  await flushPromises()

  return wrapper
}

function findButtonByText(wrapper, text) {
  return wrapper.findAll('button').find((b) => b.text() === text)
}

describe('AuthLoginPanel recovery code toggle', () => {
  it('starts the tfa screen on the 6-digit authenticator field, with no recovery field shown', async () => {
    const wrapper = await mountAtTfaScreen()

    expect(wrapper.find('input[placeholder="XXXX-XXXX-XXXX-XXXX"]').exists()).toBe(false)
    expect(findButtonByText(wrapper, 'auth.tfa.useRecoveryCode')).toBeTruthy()
  })

  it('toggling swaps in the recovery-code field and flips the toggle label', async () => {
    const wrapper = await mountAtTfaScreen()

    await findButtonByText(wrapper, 'auth.tfa.useRecoveryCode').trigger('click')

    expect(wrapper.find('input[placeholder="XXXX-XXXX-XXXX-XXXX"]').exists()).toBe(true)
    expect(findButtonByText(wrapper, 'auth.tfa.useSecurityCode')).toBeTruthy()
  })

  it('formats typed recovery code input into dash-grouped uppercase as the user types', async () => {
    const wrapper = await mountAtTfaScreen()
    await findButtonByText(wrapper, 'auth.tfa.useRecoveryCode').trigger('click')

    const recoveryInput = wrapper.find('input[placeholder="XXXX-XXXX-XXXX-XXXX"]')
    await recoveryInput.setValue('abcd1234efgh5678')

    expect(recoveryInput.element.value).toBe('ABCD-1234-EFGH-5678')
  })

  it('submits the formatted recovery code as securityCode through the same tfa endpoint', async () => {
    const wrapper = await mountAtTfaScreen()
    await findButtonByText(wrapper, 'auth.tfa.useRecoveryCode').trigger('click')

    const recoveryInput = wrapper.find('input[placeholder="XXXX-XXXX-XXXX-XXXX"]')
    await recoveryInput.setValue('abcd1234efgh5678')

    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, nextAction: 'redirect', continuationToken: '' })
    })
    await findButtonByText(wrapper, 'auth.tfa.verifyToken').trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenLastCalledWith(
      'sites/site-1/auth/tfa',
      expect.objectContaining({
        json: expect.objectContaining({
          strategyId: 'strat-1',
          securityCode: 'ABCD-1234-EFGH-5678',
          setup: false
        })
      })
    )
  })

  it('rejects an incomplete recovery code client-side rather than submitting it', async () => {
    const wrapper = await mountAtTfaScreen()
    await findButtonByText(wrapper, 'auth.tfa.useRecoveryCode').trigger('click')

    const recoveryInput = wrapper.find('input[placeholder="XXXX-XXXX-XXXX-XXXX"]')
    await recoveryInput.setValue('abcd12')

    const putCallsBefore = API_CLIENT.put.mock.calls.length
    await findButtonByText(wrapper, 'auth.tfa.verifyToken').trigger('click')
    await flushPromises()

    expect(API_CLIENT.put.mock.calls.length).toBe(putCallsBefore)
  })
})
