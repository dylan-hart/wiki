import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import AdminGeneral from './AdminGeneral.vue'
import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'
import { queue as notifyQueue } from '@/composables/notify'

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

function mountPage() {
  setActivePinia(createPinia())

  const adminStore = useAdminStore()
  const siteStore = useSiteStore()
  adminStore.currentSiteId = 'site-1'
  siteStore.id = 'site-1'
  const loadSiteSpy = vi.spyOn(siteStore, 'loadSite').mockResolvedValue()

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        common: { actions: { apply: 'Apply' } },
        admin: {
          general: {
            siteHostname: 'Site Hostname',
            hostnameChangedWarning:
              "Saved. This site's hostname changed -- navigate to {hostname} to keep administering it."
          }
        }
      }
    }
  })

  currentWrapper = mount(AdminGeneral, {
    global: { plugins: [i18n] }
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
      ratingsMode: 'off',
      profile: false,
      reasonForChange: 'required',
      search: false
    },
    defaults: { tocDepth: { min: 1, max: 2 } },
    assets: { logo: false, favicon: false }
  }
}

async function setHostnameAndSave(wrapper, newHostname) {
  const input = wrapper.get('[aria-label="Site Hostname"] input')
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
    const { wrapper, loadSiteSpy } = mountPage()
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
    const { wrapper, loadSiteSpy } = mountPage()
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
