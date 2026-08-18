import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminGeneral from './AdminGeneral.vue'
import BlueprintIcon from '@/components/BlueprintIcon.vue'

/**
 * Regression test: `<blueprint-icon indicator ...>` (a bare attribute, no `:` binding) always sends
 * the empty string as the `indicator` prop, which `BlueprintIcon`'s `indicatorDot` computed treats
 * as truthy same as any other value — so the "requires Sharp" warning showed unconditionally,
 * whether or not Sharp was actually installed. The fix fetches `GET /_api/system/extensions` on
 * mount and only passes a truthy `indicator` when the `sharp` entry reports `!isInstalled`.
 */
async function mountPage(extensionsResponse) {
  setActivePinia(createPinia())

  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'system/extensions') {
      return { json: () => Promise.resolve(extensionsResponse) }
    }
    return { json: () => Promise.resolve(undefined) }
  })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: {} },
    missingWarn: false,
    fallbackWarn: false
  })

  const wrapper = mount(AdminGeneral, {
    global: {
      plugins: [router, i18n],
      // -> `BlueprintIcon` is registered globally by `boot/components.js` in the real app, not
      //    imported per-file — this test needs the same registration for `<blueprint-icon>` to
      //    resolve.
      components: { BlueprintIcon }
    }
  })
  await flushPromises()

  return wrapper
}

describe('AdminGeneral — Sharp availability indicator', () => {
  it('hides the indicator on the logo/favicon uploaders when Sharp is installed', async () => {
    const wrapper = await mountPage([
      { key: 'sharp', title: 'Sharp', isInstalled: true, isInstallable: true, isCompatible: true }
    ])

    const icons = wrapper.findAllComponents(BlueprintIcon)
    const logoIcon = icons.find((c) => c.props('icon') === 'butterfly')
    const faviconIcon = icons.find((c) => c.props('icon') === 'starfish')

    expect(logoIcon.props('indicator')).toBe(null)
    expect(faviconIcon.props('indicator')).toBe(null)
    expect(wrapper.find('.w-badge').exists()).toBe(false)
  })

  it('shows the indicator on the logo/favicon uploaders when Sharp is not installed', async () => {
    const wrapper = await mountPage([
      { key: 'sharp', title: 'Sharp', isInstalled: false, isInstallable: true, isCompatible: true }
    ])

    const icons = wrapper.findAllComponents(BlueprintIcon)
    const logoIcon = icons.find((c) => c.props('icon') === 'butterfly')
    const faviconIcon = icons.find((c) => c.props('icon') === 'starfish')

    expect(logoIcon.props('indicator')).toBe('')
    expect(faviconIcon.props('indicator')).toBe('')
    expect(wrapper.findAll('.w-badge').length).toBeGreaterThan(0)
  })

  it('shows the indicator when the sharp entry is missing from the response entirely', async () => {
    const wrapper = await mountPage([])

    const icons = wrapper.findAllComponents(BlueprintIcon)
    const logoIcon = icons.find((c) => c.props('icon') === 'butterfly')

    expect(logoIcon.props('indicator')).toBe('')
  })
})
