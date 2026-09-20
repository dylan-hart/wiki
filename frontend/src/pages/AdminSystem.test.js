import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminSystem from './AdminSystem.vue'
import { isActive as loadingIsActive } from '@/composables/loading'
import { queue } from '@/composables/notify'

import { mountWithApp } from '../../test/mount.js'

function mountPage() {
  return mountWithApp(AdminSystem, {
    attachTo: document.body,
    messages: {
      'admin.system.schedulerHealth': 'Scheduler Health',
      'admin.system.schedulerHealthy': 'Healthy',
      'admin.system.schedulerUnhealthy': 'Unhealthy',
      'admin.system.upgradeCapable': 'Automatic Upgrades',
      'admin.system.upgradeCapableYes': 'Enabled',
      'admin.system.upgradeCapableNo': 'Not configured'
    },
    stubs: { transition: false }
  }).wrapper
}

describe('AdminSystem diagnostics fields', () => {
  it('renders isSchedulerHealthy as healthy', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          platform: 'linux',
          operatingSystem: 'Linux',
          isSchedulerHealthy: true,
          upgradeCapable: false
        })
    })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Scheduler Health')
    expect(wrapper.text()).toContain('Healthy')
    expect(wrapper.text()).not.toContain('Unhealthy')

    wrapper.unmount()
  })

  it('renders isSchedulerHealthy as unhealthy', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          platform: 'linux',
          operatingSystem: 'Linux',
          isSchedulerHealthy: false,
          upgradeCapable: false
        })
    })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Unhealthy')

    wrapper.unmount()
  })

  it('renders upgradeCapable', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          platform: 'linux',
          operatingSystem: 'Linux',
          isSchedulerHealthy: true,
          upgradeCapable: true
        })
    })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Automatic Upgrades')
    expect(wrapper.text()).toContain('Enabled')

    wrapper.unmount()
  })
})

describe('AdminSystem load() error handling (OpenProject #947)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hides the loading overlay and notifies instead of leaving it stuck when load() rejects', async () => {
    queue.splice(0, queue.length)
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.reject(new Error('Network error'))
    })

    const wrapper = mountPage()
    // -> `loading.show()` has a 500ms delay of its own, so `isActive` never flips `true` until it
    //    elapses: without advancing past it an overlay stuck up forever would still read as `false`.
    await vi.advanceTimersByTimeAsync(600)

    expect(loadingIsActive.value).toBe(false)
    expect(queue.at(-1)).toMatchObject({ type: 'negative', caption: 'Network error' })

    wrapper.unmount()
  })
})

describe('AdminSystem product name (WP #2653)', () => {
  const originalClipboard = navigator.clipboard

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
      writable: true
    })
  })

  it('heads the system card with Cardinal.js, not upstream Wiki.js', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ platform: 'linux', operatingSystem: 'Linux' })
    })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Cardinal.js')
    expect(wrapper.text()).not.toContain('Wiki.js')

    wrapper.unmount()
  })

  it('opens the copied system-info block with the Cardinal.js version line', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true
    })

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          currentVersion: '3.0.0-alpha.1',
          platform: 'linux',
          operatingSystem: 'Linux',
          nodeVersion: '26.0.0',
          cpuCores: 8,
          ramTotal: '16 GB'
        })
    })

    const wrapper = mountPage()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    await wrapper.vm.copySysInfo()

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0].split('\n')[0]).toBe('Cardinal.js 3.0.0-alpha.1')

    wrapper.unmount()
  })
})
