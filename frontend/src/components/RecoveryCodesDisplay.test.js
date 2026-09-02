import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import RecoveryCodesDisplay from './RecoveryCodesDisplay.vue'

vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/helpers/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined)
}))

import { fileSave } from 'browser-fs-access'
import { copyToClipboard } from '@/helpers/clipboard'

import { createTestI18n } from '../../test/i18n.js'

const CODES = ['AAAA-1111-BBBB-2222', 'CCCC-3333-DDDD-4444']

function mountDisplay(props = {}) {
  const i18n = createTestI18n()
  return mount(RecoveryCodesDisplay, {
    props: { codes: CODES, ...props },
    global: { plugins: [i18n] }
  })
}

describe('RecoveryCodesDisplay', () => {
  it('renders every code', () => {
    const wrapper = mountDisplay()
    const text = wrapper.text()
    for (const code of CODES) {
      expect(text).toContain(code)
    }
  })

  it('copies every code newline-separated and marks acknowledged on success', async () => {
    const wrapper = mountDisplay()
    await wrapper.find('button').trigger('click')
    await new Promise((resolve) => setTimeout(resolve))

    expect(copyToClipboard).toHaveBeenCalledWith(CODES.join('\n'))
    expect(wrapper.emitted('update:acknowledged')).toEqual([[true]])
  })

  it('saves a text file of the codes and marks acknowledged on success', async () => {
    const wrapper = mountDisplay()
    const buttons = wrapper.findAll('button')
    await buttons[1].trigger('click')
    await new Promise((resolve) => setTimeout(resolve))

    expect(fileSave).toHaveBeenCalledTimes(1)
    const [blob, opts] = fileSave.mock.calls[0]
    expect(blob).toBeInstanceOf(Blob)
    expect(opts.fileName).toBe('wiki-recovery-codes.txt')
    expect(wrapper.emitted('update:acknowledged')).toEqual([[true]])
  })

  it('does not mark acknowledged when the copy fails', async () => {
    copyToClipboard.mockRejectedValueOnce(new Error('nope'))
    const wrapper = mountDisplay()
    await wrapper.find('button').trigger('click')
    await new Promise((resolve) => setTimeout(resolve))

    expect(wrapper.emitted('update:acknowledged')).toBeUndefined()
  })
})
