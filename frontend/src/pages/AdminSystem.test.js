import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminSystem from './AdminSystem.vue'
import { isActive as loadingIsActive } from '@/composables/loading'
import { queue } from '@/composables/notify'

import { mountWithApp } from '../../test/mount.js'

/**
 * Task 605 verification pass: `GET /_api/system/info` (`system.ts:77-216`) surfaces `isSchedulerHealthy`
 * and `upgradeCapable`, and neither was rendered anywhere in the app — not on this page, and not (unlike
 * `loginsPastDay`, `activeWorkers`, `instancesTotal`, `webhooksTotal`, `groupsTotal`, `usersTotal`,
 * which turned out to already be covered by `AdminDashboard.vue`'s stat tiles) on any other admin page
 * either. Both are genuine dashboard-worthy signals — a scheduler that stopped renewing its cron lock is
 * an operational problem, and whether an update companion is present belongs right next to the
 * version/upgrade card — so they were added to the "Cardinal.js" card here instead of being left as
 * response-schema dead weight.
 */
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

/**
 * OpenProject #947: `load()` ran `await API_CLIENT.get('system/info')` bare between `loading.show()`
 * and `loading.hide()`, unlike every sibling admin page's own `load()` -- a network blip, 403, or
 * restarting backend left the full-screen blocking overlay stuck up forever with the error only in
 * the console.
 */
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
    // -> `loading.show()`'s own 500ms delay -- see `composables/loading.js` -- has to actually elapse
    //    for `isActive` to ever flip `true` at all; advancing past it is what would have caught the
    //    overlay stuck on `true` forever pre-fix, since a bare, unguarded `await` never reaches the
    //    matching `loading.hide()` below it.
    await vi.advanceTimersByTimeAsync(600)

    expect(loadingIsActive.value).toBe(false)
    expect(queue.at(-1)).toMatchObject({ type: 'negative', caption: 'Network error' })

    wrapper.unmount()
  })
})

/**
 * WP #2653 (rebrand: user-facing strings): this page carries two of the fork's few remaining
 * hardcoded product names -- the left card's own header, and the first line of the block
 * `copySysInfo()` puts on the clipboard for pasting into a bug report. Both are read by a person, so
 * both are pinned here; the version number beside the second one is what makes it worth asserting as
 * a whole line rather than as a bare substring.
 */
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
