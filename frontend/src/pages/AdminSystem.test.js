import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminSystem from './AdminSystem.vue'
import BlueprintIcon from '@/components/BlueprintIcon.vue'

/**
 * Task 605 verification pass: `GET /_api/system/info` (`system.ts:77-216`) surfaces `isSchedulerHealthy`
 * and `upgradeCapable`, and neither was rendered anywhere in the app — not on this page, and not (unlike
 * `loginsPastDay`, `activeWorkers`, `instancesTotal`, `webhooksTotal`, `groupsTotal`, `usersTotal`,
 * which turned out to already be covered by `AdminDashboard.vue`'s stat tiles) on any other admin page
 * either. Both are genuine dashboard-worthy signals — a scheduler that stopped renewing its cron lock is
 * an operational problem, and whether an update companion is present belongs right next to the
 * version/upgrade card — so they were added to the "Wiki.js" card here instead of being left as
 * response-schema dead weight.
 */
function mountPage() {
  setActivePinia(createPinia())

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        'admin.system.schedulerHealth': 'Scheduler Health',
        'admin.system.schedulerHealthy': 'Healthy',
        'admin.system.schedulerUnhealthy': 'Unhealthy',
        'admin.system.upgradeCapable': 'Automatic Upgrades',
        'admin.system.upgradeCapableYes': 'Enabled',
        'admin.system.upgradeCapableNo': 'Not configured'
      }
    }
  })

  return mount(AdminSystem, {
    global: {
      plugins: [i18n],
      components: { BlueprintIcon },
      // -> `ClipboardJS` binds to the copy button's real DOM element in `onMounted`; `attachTo`
      //    ensures the component tree is actually in the document rather than detached, matching how
      //    `AdminSystem.vue` expects to be mounted.
      stubs: { transition: false }
    },
    attachTo: document.body
  })
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
