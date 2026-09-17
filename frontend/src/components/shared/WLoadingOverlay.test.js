import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import WLoadingOverlay from './WLoadingOverlay.vue'
import { loading } from '@/composables/loading'

import { createTestI18n } from '../../../test/i18n.js'

/**
 * OpenProject #3385: the overlay used to render only a bare spinner regardless of what `show()`
 * was called with, so a slow login/register/TFA wait was a wordless black screen. Teleport is
 * stubbed the same way `WNotifications.test.js` does it, so a plain `wrapper.find()` reaches the
 * content without going to `document.body`.
 */

function mountOverlay() {
  return mount(WLoadingOverlay, {
    global: {
      plugins: [createTestI18n({ common: { loading: 'Loading...' } })],
      stubs: { teleport: true }
    }
  })
}

describe('WLoadingOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    loading.hide()
    vi.useRealTimers()
  })

  it('renders the message and caption passed to show()', async () => {
    const wrapper = mountOverlay()

    loading.show({ message: 'Signing in...', caption: 'One moment' })
    vi.advanceTimersByTime(500)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.w-loading-message').text()).toBe('Signing in...')
    expect(wrapper.find('.w-loading-caption').text()).toBe('One moment')
  })

  it('omits the caption line entirely when none was given', async () => {
    const wrapper = mountOverlay()

    loading.show({ message: 'Signing in...' })
    vi.advanceTimersByTime(500)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.w-loading-message').exists()).toBe(true)
    expect(wrapper.find('.w-loading-caption').exists()).toBe(false)
  })

  it('uses the message as the aria-label, falling back to the generic string when there is none', async () => {
    const wrapper = mountOverlay()

    loading.show({ message: 'Signing in...' })
    vi.advanceTimersByTime(500)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.w-loading').attributes('aria-label')).toBe('Signing in...')

    loading.hide()
    loading.show()
    vi.advanceTimersByTime(500)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.w-loading').attributes('aria-label')).toBe('Loading...')
  })

  it('renders nothing visible when the overlay is not active', () => {
    const wrapper = mountOverlay()

    expect(wrapper.find('.w-loading').exists()).toBe(false)
  })
})
