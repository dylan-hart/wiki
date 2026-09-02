import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import VOtpInput from 'vue3-otp-input'

import SetupTfaDialog from './SetupTfaDialog.vue'
import { openDialogs } from '@/composables/dialog'

import { createTestI18n } from '../../test/i18n.js'

vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/helpers/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined)
}))

const RECOVERY_CODES = ['AAAA-1111-BBBB-2222', 'CCCC-3333-DDDD-4444']

function mountDialog() {
  API_CLIENT.post.mockReturnValueOnce({
    json: () =>
      Promise.resolve({
        ok: true,
        continuationToken: 'ct-1',
        tfaQRImage: '<svg></svg>',
        tfaSecret: 'ABCD1234EFGH5678'
      })
  })

  const i18n = createTestI18n()
  return mount(SetupTfaDialog, {
    props: { strategyId: 'strat-1' },
    // -> `WDialog` teleports its panel to `<body>`; stubbing keeps it inside the wrapper's own tree
    //    so `wrapper.text()` / `wrapper.find()` can still see it
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
}

/** Fills the OTP widget and clicks Verify, without depending on its internal DOM structure. */
async function enterCodeAndVerify(wrapper, code) {
  await wrapper.findComponent(VOtpInput).vm.$emit('update:value', code)
  const verifyBtn = wrapper.findAll('button').find((b) => b.text() === 'auth.tfa.verifyToken')
  await verifyBtn.trigger('click')
  await flushPromises()
}

describe('SetupTfaDialog', () => {
  it('loads the secret and shows the code-entry step first', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    // -> `groupedSecret` displays the raw secret grouped by spaces, not the recovery codes' dashes
    expect(wrapper.text()).toContain('ABCD 1234 EFGH 5678')
  })

  it('shows the freshly-issued recovery codes after a correct code is verified', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          message: 'ok',
          recoveryCodes: RECOVERY_CODES
        })
    })

    await enterCodeAndVerify(wrapper, '123456')

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      'users/profile/tfa',
      expect.objectContaining({
        json: expect.objectContaining({
          strategyId: 'strat-1',
          continuationToken: 'ct-1',
          securityCode: '123456'
        })
      })
    )
    for (const code of RECOVERY_CODES) {
      expect(wrapper.text()).toContain(code)
    }
    // -> Not confirmed yet -- the dialog must not have closed itself
    expect(wrapper.emitted('ok')).toBeUndefined()
  })

  it('warns before closing the codes step when nothing has been copied or downloaded', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, recoveryCodes: RECOVERY_CODES })
    })
    await enterCodeAndVerify(wrapper, '123456')

    const dialogCountBefore = openDialogs.length
    const closeBtn = wrapper.findAll('button').find((b) => b.text() === 'common.actions.close')
    await closeBtn.trigger('click')

    // -> A confirmation dialog was opened rather than the setup dialog closing immediately
    expect(openDialogs.length).toBe(dialogCountBefore + 1)
    expect(wrapper.emitted('ok')).toBeUndefined()

    // -> Confirming the warning finishes the close
    const confirmEntry = openDialogs[openDialogs.length - 1]
    confirmEntry.handlers.ok[0](true)
    expect(wrapper.emitted('ok')).toHaveLength(1)
  })

  it('closes immediately once the codes have been copied', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, recoveryCodes: RECOVERY_CODES })
    })
    await enterCodeAndVerify(wrapper, '123456')

    const copyBtn = wrapper.findAll('button').find((b) => b.text() === 'common.actions.copy')
    await copyBtn.trigger('click')
    await flushPromises()

    const dialogCountBefore = openDialogs.length
    const closeBtn = wrapper.findAll('button').find((b) => b.text() === 'common.actions.close')
    await closeBtn.trigger('click')

    expect(openDialogs.length).toBe(dialogCountBefore)
    expect(wrapper.emitted('ok')).toHaveLength(1)
  })
})
