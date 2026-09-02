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
 * Regression test: `<blueprint-icon indicator ...>` (a bare attribute, no `:` binding) always sends
 * the empty string as the `indicator` prop, which `BlueprintIcon`'s `indicatorDot` computed treats
 * as truthy same as any other value — so the "requires Sharp" warning showed unconditionally,
 * whether or not Sharp was actually installed. The fix fetches `GET /_api/system/extensions` on
 * mount and only passes a truthy `indicator` when the `sharp` entry reports `!isInstalled`.
 */
async function mountPage(extensionsResponse) {
  stubApi({ 'system/extensions': extensionsResponse })

  const router = await createTestRouter(['/'], '/')

  const { wrapper } = mountWithApp(AdminGeneral, { router })
  await flushPromises()

  return wrapper
}

/**
 * Regression coverage for Task 588: `defaultConfig()` used to seed a `defaults.timezone` /
 * `dateFormat` / `timeFormat` sub-object that rendered no control in the template, was dropped by
 * `save()` before it ever reached the API, and had no backend counterpart (per-user timezone/date/time
 * preferences live in `ProfileInfo.vue` instead). Removing that dead scaffolding must not change what
 * `save()` actually sends — this mounts the real page, loads a fixture site through it, and asserts
 * the `PUT /_api/sites/:id` body still carries every field the admin UI is responsible for, unchanged.
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
  logoText: true,
  discoverable: true,
  sitemap: true,
  robots: { index: true, follow: false },
  uploads: { conflictBehavior: 'reject' },
  features: {
    browse: true,
    comments: true,
    profile: true,
    reasonForChange: 'optional',
    search: true,
    showOtherGroups: true
  },
  defaults: { tocDepth: { min: 2, max: 4 } },
  assets: { logo: false, favicon: false }
}

async function mountLoaded() {
  // -> `manage:sites` satisfies `useSiteAdminAccess('site:general')`'s GLOBAL_FALLBACKS check on its
  //    own, so it skips its site-scoped `fetchSitePermissions` network call entirely -- otherwise
  //    that call, not `load()`'s, would consume the single `mockReturnValueOnce` below.

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
      logoText: FIXTURE_SITE.logoText,
      sitemap: FIXTURE_SITE.sitemap,
      uploads: { conflictBehavior: 'reject' },
      robots: { index: true, follow: false },
      features: {
        browse: true,
        comments: true,
        profile: true,
        reasonForChange: 'optional',
        search: true,
        showOtherGroups: true
      },
      discoverable: true,
      defaults: { tocDepth: { min: 2, max: 4 } }
    })
  })
})

/**
 * Regression coverage for the save handler's post-save reload decision.
 *
 * Before this fix, saving ANY change to the currently-administered site unconditionally called
 * `siteStore.loadSite(window.location.hostname)` -- including a hostname rename, at which point
 * `window.location.hostname` is exactly the OLD hostname `updateSite()`'s `reloadCache()` already
 * dropped from `WIKI.sitesMappings`. That call would then silently resolve against whatever site
 * (if any) now claims the old hostname, or throw -- either way `siteStore` ends up mismatched with
 * no warning. The fix: detect the rename and skip that stale reload, notifying the admin instead.
 */

let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
  // -> `notify()`'s queue is a module-level singleton (by design -- there is one toast stack for
  //    the whole app), so it survives across tests in this file unless cleared explicitly. Left in
  //    place, a later test's IDENTICAL "saved successfully" toast dedupes onto an earlier test's
  //    entry (bumping its `count` in place) rather than appending a new one, which reorders what
  //    `.at(-1)` sees.
  notifyQueue.splice(0)
})

async function mountRenamePage() {
  setActivePinia(createPinia())

  const adminStore = useAdminStore()
  const siteStore = useSiteStore()
  adminStore.currentSiteId = 'site-1'
  siteStore.id = 'site-1'
  const loadSiteSpy = vi.spyOn(siteStore, 'loadSite').mockResolvedValue()
  // -> `manage:sites` satisfies `useSiteAdminAccess('site:general')`'s GLOBAL_FALLBACKS check on its
  //    own, same as `mountLoaded()` above, so it skips the site-scoped `fetchSitePermissions` network
  //    call that would otherwise consume the `mockReturnValueOnce`s each test sets up below.
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
    // -> The success toast from the save itself is the LAST thing notified in this branch -- no
    //    warning toast follows it, unlike the rename case above.
    expect(notifyQueue.at(-1)?.type).toBe('positive')
  })
})

/**
 * OpenProject #947: `load()` ran `await API_CLIENT.get(...)` bare between `loading.show()`/
 * `loading.hide()`, unlike every sibling admin page's own `load()` -- a network blip, 403, or
 * restarting backend left the full-screen blocking overlay stuck up forever with the error only in
 * the console.
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
    // -> `loading.show()`'s own 500ms delay -- see `composables/loading.js` -- has to actually
    //    elapse for `isActive` to ever flip `true` at all; advancing past it is what would have
    //    caught the overlay stuck on `true` forever pre-fix, since a bare, unguarded `await` never
    //    reaches the matching `loading.hide()` below it.
    await vi.advanceTimersByTimeAsync(600)

    expect(loadingIsActive.value).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative', caption: 'Network error' })

    wrapper.unmount()
  })
})
