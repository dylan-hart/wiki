import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import RecoveryCodesDialog from './RecoveryCodesDialog.vue'
import { openDialogs } from '@/composables/dialog'

import { createTestI18n } from '../../test/i18n.js'

vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/helpers/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined)
}))

const CODES = ['AAAA-1111-BBBB-2222', 'CCCC-3333-DDDD-4444']

function mountDialog() {
  const i18n = createTestI18n()
  return mount(RecoveryCodesDialog, {
    props: { codes: CODES },
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
}

describe('RecoveryCodesDialog', () => {
  it('renders every code passed in', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    for (const code of CODES) {
      expect(wrapper.text()).toContain(code)
    }
  })

  it('confirms before closing when nothing was copied or downloaded, and closes on confirmation', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    const dialogCountBefore = openDialogs.length

    const closeBtn = wrapper.findAll('button').find((b) => b.text() === 'common.actions.close')
    await closeBtn.trigger('click')

    expect(openDialogs.length).toBe(dialogCountBefore + 1)
    expect(wrapper.emitted('ok')).toBeUndefined()

    openDialogs[openDialogs.length - 1].handlers.ok[0](true)
    expect(wrapper.emitted('ok')).toHaveLength(1)
  })

  it('closes immediately once a download has been triggered', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    const downloadBtn = wrapper
      .findAll('button')
      .find((b) => b.text() === 'common.actions.download')
    await downloadBtn.trigger('click')
    await new Promise((resolve) => setTimeout(resolve))

    const dialogCountBefore = openDialogs.length
    const closeBtn = wrapper.findAll('button').find((b) => b.text() === 'common.actions.close')
    await closeBtn.trigger('click')

    expect(openDialogs.length).toBe(dialogCountBefore)
    expect(wrapper.emitted('ok')).toHaveLength(1)
  })
})
