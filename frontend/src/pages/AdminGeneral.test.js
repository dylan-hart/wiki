import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import AdminGeneral from './AdminGeneral.vue'
import BlueprintIcon from '@/components/BlueprintIcon.vue'
import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'
import { useSiteStore } from '@/stores/site'
import { queue as notifyQueue } from '@/composables/notify'
import { isActive as loadingIsActive } from '@/composables/loading'

import { createTestI18n } from '../../test/i18n.js'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * A bare `indicator` attribute binds the empty string, which `BlueprintIcon` treats as truthy —
 * which is why `''`, not `true`, is what "indicator shown" asserts as below.
 */
async function mountPage(extensionsResponse) {
  stubApi({ 'system/extensions': extensionsResponse })

  const router = await createTestRouter(['/'], '/')

  const { wrapper } = mountWithApp(AdminGeneral, { router })
  await flushPromises()

  return wrapper
}

/**
 * Every field this page is responsible for. `defaults.timezone`/`dateFormat`/`timeFormat` are
 * absent on purpose: those are per-user preferences owned by `ProfileInfo.vue`, with no site-level
 * control or backend counterpart.
 */
const FIXTURE_SITE = {
  id: 'site-1',
  hostname: 'wiki.example.com',
  title: 'My Wiki',
  description: 'A description',
  company: 'Acme Corp',
  contentLicense: 'ccby',
  footerExtra: 'footer text',
  pageExtensions: ['md', 'html'],
  allowedUrlSchemes: ['discord'],
  logoText: true,
  discoverable: true,
  sitemap: true,
  robots: { index: true, follow: false },
  security: { embedAllowedOrigins: ['https://intranet.example.com'] },
  uploads: { conflictBehavior: 'reject' },
  features: {
    browse: true,
    comments: true,
    pageScripts: true,
    profile: true,
    reasonForChange: 'optional',
    search: true,
    showOtherGroups: true
  },
  defaults: { tocDepth: { min: 2, max: 4 } },
  assets: { logo: false, favicon: false }
}

async function mountLoaded() {
  // -> `manage:sites` satisfies `useSiteAdminAccess('site:general')`'s GLOBAL_FALLBACKS check on
  //    its own, skipping the site-scoped `fetchSitePermissions` request that would otherwise
  //    consume the single `mockReturnValueOnce` below instead of `load()`'s.

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_SITE) })

  const router = await createTestRouter(
    ['/_admin/:siteid/general'],
    `/_admin/${FIXTURE_SITE.id}/general`
  )

  const { wrapper } = mountWithApp(AdminGeneral, {
    router,
    stores: { admin: { currentSiteId: FIXTURE_SITE.id }, user: { permissions: ['manage:sites'] } }
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
    const logoIcon = icons.find((c) => c.props('icon') === 'tabler:photo')
    const faviconIcon = icons.find((c) => c.props('icon') === 'tabler:browser')

    expect(logoIcon.props('indicator')).toBe(null)
    expect(faviconIcon.props('indicator')).toBe(null)
    expect(wrapper.find('.w-badge').exists()).toBe(false)
  })

  it('shows the indicator on the logo/favicon uploaders when Sharp is not installed', async () => {
    const wrapper = await mountPage([
      { key: 'sharp', title: 'Sharp', isInstalled: false, isInstallable: true, isCompatible: true }
    ])

    const icons = wrapper.findAllComponents(BlueprintIcon)
    const logoIcon = icons.find((c) => c.props('icon') === 'tabler:photo')
    const faviconIcon = icons.find((c) => c.props('icon') === 'tabler:browser')

    expect(logoIcon.props('indicator')).toBe('')
    expect(faviconIcon.props('indicator')).toBe('')
    expect(wrapper.findAll('.w-badge').length).toBeGreaterThan(0)
  })

  it('shows the indicator when the sharp entry is missing from the response entirely', async () => {
    const wrapper = await mountPage([])

    const icons = wrapper.findAllComponents(BlueprintIcon)
    const logoIcon = icons.find((c) => c.props('icon') === 'tabler:photo')

    expect(logoIcon.props('indicator')).toBe('')
  })
})

/**
 * The preview's image and its title text must come from the same source: `adminStore.currentSiteId`
 * updates synchronously on a site switch while `state.config` only catches up when `load()`
 * resolves, so keying the image off the store would paint the new site's logo beside the old site's
 * title. The 500ms delay before `loading.show()`'s overlay appears leaves that visible.
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

    const router = await createTestRouter(['/'], '/')

    const i18n = createTestI18n()

    const wrapper = mount(AdminGeneral, {
      global: { plugins: [router, i18n] }
    })
    await flushPromises()

    return { wrapper, adminStore, pending }
  }

  it("never shows a new site's logo image next to the old site's title while the switch is in flight", async () => {
    const { wrapper, adminStore, pending } = await mountWithTwoSites()

    expect(wrapper.text()).toContain('Site A')
    const logoImgBefore = wrapper.find('.bg-header img')
    expect(logoImgBefore.attributes('src')).toContain('site-a')

    // `sites/site-b?strict=true` is left unresolved above, pinning the switch mid-flight.
    adminStore.currentSiteId = 'site-b'
    await wrapper.vm.$nextTick()

    // Either site is acceptable here; a mix of the two is not.
    const logoImgDuring = wrapper.find('.bg-header img')
    const titleDuring = wrapper.text()
    if (logoImgDuring.attributes('src').includes('site-b')) {
      expect(titleDuring).not.toContain('Site A')
    } else {
      expect(logoImgDuring.attributes('src')).toContain('site-a')
    }

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

describe('AdminGeneral save() field round-trip', () => {
  it('sends every field load() populated, and never re-introduces defaults.timezone/dateFormat/timeFormat', async () => {
    const wrapper = await mountLoaded()

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([FIXTURE_SITE]) })

    const applyBtn = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('common.actions.apply'))
    await applyBtn.trigger('click')
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
    const [url, options] = API_CLIENT.put.mock.calls[0]
    expect(url).toBe(`sites/${FIXTURE_SITE.id}`)

    expect(options.json).toEqual({
      hostname: FIXTURE_SITE.hostname,
      title: FIXTURE_SITE.title,
      description: FIXTURE_SITE.description,
      company: FIXTURE_SITE.company,
      contentLicense: FIXTURE_SITE.contentLicense,
      footerExtra: FIXTURE_SITE.footerExtra,
      pageExtensions: FIXTURE_SITE.pageExtensions,
      allowedUrlSchemes: FIXTURE_SITE.allowedUrlSchemes,
      logoText: FIXTURE_SITE.logoText,
      sitemap: FIXTURE_SITE.sitemap,
      uploads: { conflictBehavior: 'reject' },
      robots: { index: true, follow: false },
      security: { embedAllowedOrigins: FIXTURE_SITE.security.embedAllowedOrigins },
      features: {
        browse: true,
        comments: true,
        pageScripts: true,
        profile: true,
        reasonForChange: 'optional',
        search: true,
        showOtherGroups: true
      },
      discoverable: true,
      defaults: { tocDepth: { min: 2, max: 4 } }
    })
  })

  // -> `api/schemas/site.ts` only accepts lowercase origins, so the page must normalise before PUT.
  it('parses the embed-allowed-origins field as a trimmed, lowercased, deduped array', async () => {
    const wrapper = await mountLoaded()

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([FIXTURE_SITE]) })

    const input = wrapper.get('[aria-label="admin.general.embedAllowedOrigins"]')
    await input.setValue(
      ' https://Intranet.example.com , https://portal.example.com,https://intranet.example.com '
    )

    const applyBtn = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('common.actions.apply'))
    await applyBtn.trigger('click')
    await flushPromises()

    const [, options] = API_CLIENT.put.mock.calls[0]
    expect(options.json.security).toEqual({
      embedAllowedOrigins: ['https://intranet.example.com', 'https://portal.example.com']
    })
  })
})

/**
 * After a hostname rename, `window.location.hostname` is the OLD hostname, which the server has
 * already dropped from its site mappings — so reloading `siteStore` from it resolves against some
 * other site or throws. The save handler must skip that reload and warn instead.
 */

let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
  // -> One toast stack for the whole app, so the queue survives between tests: an identical toast
  //    would dedupe onto the previous test's entry instead of appending, breaking `.at(-1)`.
  notifyQueue.splice(0)
})

async function mountRenamePage() {
  setActivePinia(createPinia())

  const adminStore = useAdminStore()
  const siteStore = useSiteStore()
  adminStore.currentSiteId = 'site-1'
  siteStore.id = 'site-1'
  const loadSiteSpy = vi.spyOn(siteStore, 'loadSite').mockResolvedValue()
  // -> Skips `fetchSitePermissions`, which would otherwise eat each test's `mockReturnValueOnce`.
  const userStore = useUserStore()
  userStore.permissions = ['manage:sites']

  const router = await createTestRouter(['/_admin/:siteid/general'], '/_admin/site-1/general')

  const i18n = createTestI18n({
    common: { actions: { apply: 'Apply' } },
    admin: {
      general: {
        siteHostname: 'Site Hostname',
        hostnameChangedWarning:
          "Saved. This site's hostname changed -- navigate to {hostname} to keep administering it."
      }
    }
  })

  currentWrapper = mount(AdminGeneral, {
    global: { plugins: [router, i18n] }
  })
  return { wrapper: currentWrapper, adminStore, siteStore, loadSiteSpy }
}

function siteResponse(hostname) {
  return {
    id: 'site-1',
    hostname,
    title: 'Test Site',
    description: '',
    company: '',
    contentLicense: '',
    footerExtra: '',
    pageExtensions: ['md'],
    logoText: false,
    sitemap: false,
    discoverable: false,
    uploads: { conflictBehavior: 'overwrite' },
    robots: { index: false, follow: false },
    features: {
      browse: false,
      comments: false,
      profile: false,
      reasonForChange: 'required',
      search: false
    },
    defaults: { tocDepth: { min: 1, max: 2 } },
    assets: { logo: false, favicon: false }
  }
}

async function setHostnameAndSave(wrapper, newHostname) {
  const input = wrapper.get('[aria-label="Site Hostname"]')
  await input.setValue(newHostname)
  const applyButton = wrapper.findAll('button').find((btn) => btn.text() === 'Apply')
  await applyButton.trigger('click')
  await flushPromises()
}

describe('AdminGeneral save() hostname-rename handling', () => {
  it('skips the stale loadSite(window.location.hostname) call and warns when the hostname changed', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve(siteResponse('old.example.com'))
    })
    const { wrapper, loadSiteSpy } = await mountRenamePage()
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) }) // adminStore.fetchSites()

    await setHostnameAndSave(wrapper, 'new.example.com')

    expect(loadSiteSpy).not.toHaveBeenCalled()
    expect(
      notifyQueue.some((n) => n.type === 'warning' && n.message.includes('new.example.com'))
    ).toBe(true)
  })

  it('still reloads siteStore from window.location.hostname when the hostname did not change', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve(siteResponse('same.example.com'))
    })
    const { wrapper, loadSiteSpy } = await mountRenamePage()
    await flushPromises()

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) }) // adminStore.fetchSites()

    await setHostnameAndSave(wrapper, 'same.example.com')

    expect(loadSiteSpy).toHaveBeenCalledWith(window.location.hostname)
    // -> No warning toast follows the save's own, unlike the rename case above.
    expect(notifyQueue.at(-1)?.type).toBe('positive')
  })
})

/**
 * An unguarded `await` between `loading.show()` and `loading.hide()` leaves the full-screen
 * blocking overlay up forever on any rejection, with the error only in the console.
 */
describe('AdminGeneral load() error handling (OpenProject #947)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hides the loading overlay and notifies instead of leaving it stuck when load() rejects', async () => {
    notifyQueue.splice(0, notifyQueue.length)

    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.reject(new Error('Network error')) })

    const router = await createTestRouter(['/_admin/:siteid/general'], '/_admin/site-1/general')

    const { wrapper } = mountWithApp(AdminGeneral, {
      router,
      stores: { admin: { currentSiteId: 'site-1' }, user: { permissions: ['manage:sites'] } }
    })
    // -> `loading.show()` only flips `isActive` after a 500ms delay, so the timers have to be
    //    advanced past it or the assertion below passes without the overlay ever having been up.
    await vi.advanceTimersByTimeAsync(600)

    expect(loadingIsActive.value).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative', caption: 'Network error' })

    wrapper.unmount()
  })
})
