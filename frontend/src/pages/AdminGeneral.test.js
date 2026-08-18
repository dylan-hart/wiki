import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminGeneral from './AdminGeneral.vue'
import BlueprintIcon from '@/components/BlueprintIcon.vue'
import { useAdminStore } from '@/stores/admin'

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

/**
 * Task 749: the preview toolbar (~lines 331-347) and the favicon preview row (~lines 396-403) render
 * their `<img>` from `adminStore.currentSiteId` directly but their title text from
 * `state.config.title` / `state.config.logoText` -- form state that only refreshes once `load()`'s
 * `GET sites/:id` response comes back. Switching sites updates the store synchronously, so for the
 * span between that and `load()` resolving, the preview showed the NEW site's logo/favicon image
 * next to the OLD site's title -- a genuine mismatched-preview bug, not just a fleeting repaint,
 * because `loading.show()`'s overlay only appears after a 500ms delay and most responses are faster
 * than that. The fix keys the image off `state.config.id` instead, so image and text are always
 * swapped in the same atomic `state.config = ...` assignment.
 */
describe('AdminGeneral — preview toolbar across a site switch', () => {
  async function mountWithTwoSites() {
    setActivePinia(createPinia())
    const adminStore = useAdminStore()
    adminStore.currentSiteId = 'site-a'

    const pending = {}
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'system/extensions') {
        return { json: () => Promise.resolve([]) }
      }
      if (url === 'sites/site-a?strict=true') {
        return {
          json: () =>
            Promise.resolve({
              id: 'site-a',
              title: 'Site A',
              logoText: true,
              pageExtensions: [],
              assets: {}
            })
        }
      }
      if (url === 'sites/site-b?strict=true') {
        return {
          json: () =>
            new Promise((resolve) => {
              pending.resolveSiteB = resolve
            })
        }
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
      global: { plugins: [router, i18n], components: { BlueprintIcon } }
    })
    await flushPromises()

    return { wrapper, adminStore, pending }
  }

  it("never shows a new site's logo image next to the old site's title while the switch is in flight", async () => {
    const { wrapper, adminStore, pending } = await mountWithTwoSites()

    expect(wrapper.text()).toContain('Site A')
    const logoImgBefore = wrapper.find('.bg-header img')
    expect(logoImgBefore.attributes('src')).toContain('site-a')

    // Switch sites -- `sites/site-b?strict=true` deliberately left unresolved above.
    adminStore.currentSiteId = 'site-b'
    await wrapper.vm.$nextTick()

    // Still mid-flight: the preview must show ONE consistent site, not site B's image glued to
    // site A's title.
    const logoImgDuring = wrapper.find('.bg-header img')
    const titleDuring = wrapper.text()
    if (logoImgDuring.attributes('src').includes('site-b')) {
      expect(titleDuring).not.toContain('Site A')
    } else {
      expect(logoImgDuring.attributes('src')).toContain('site-a')
    }

    // Resolve site B's load -- now both image and title must agree on site B.
    pending.resolveSiteB({
      id: 'site-b',
      title: 'Site B',
      logoText: true,
      pageExtensions: [],
      assets: {}
    })
    await flushPromises()

    expect(wrapper.find('.bg-header img').attributes('src')).toContain('site-b')
    expect(wrapper.text()).toContain('Site B')
    expect(wrapper.text()).not.toContain('Site A')
  })
})
