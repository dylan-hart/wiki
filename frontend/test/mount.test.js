import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { getActivePinia } from 'pinia'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestRouter } from './router.js'
import { mountWithApp } from './mount.js'
import { seedAdmin, seedPage, seedSite, seedUser, stubRouter } from './fixtures.js'

/**
 * `mountWithApp` replaces the 76 per-file `mountDialog`/`mountPage`/`mountOverlay`/`mountEditor`
 * helpers the survey counted (TEST-F5) -- the same four lines each: a fresh pinia, a `createI18n`, a
 * `mount()` with `global.plugins`, and (in 92 places) a single-field store seed before the mount.
 *
 * Store seeding stays OPT-IN at the call, deliberately: `pages/ProfileInfo.test.js` and others
 * assert against a store nothing has touched, so a helper that seeded by default would quietly
 * change what they cover. Nothing is written to a store unless `stores` names it.
 */
const Probe = {
  props: { label: { type: String, default: '' } },
  template: '<div class="probe">{{ label }}{{ $t("probe.title") }}</div>'
}

const Teleporting = {
  template: '<teleport to="body"><span class="inside">x</span></teleport>'
}

describe('mountWithApp', () => {
  it('mounts with a fresh active pinia per call', () => {
    const first = mountWithApp(Probe)
    const firstPinia = getActivePinia()
    const second = mountWithApp(Probe)
    expect(getActivePinia()).not.toBe(firstPinia)
    first.wrapper.unmount()
    second.wrapper.unmount()
  })

  it('installs an i18n built from messages', () => {
    const { wrapper } = mountWithApp(Probe, { messages: { probe: { title: 'Probe' } } })
    expect(wrapper.text()).toBe('Probe')
  })

  it('passes props through', () => {
    const { wrapper } = mountWithApp(Probe, { props: { label: 'hi ' } })
    expect(wrapper.text()).toBe('hi probe.title')
  })

  it('installs a router built from routes and initialPath, settling on the first await', async () => {
    const { wrapper } = mountWithApp(Probe, { routes: ['/', '/other'], initialPath: '/other' })
    await flushPromises()
    expect(wrapper.vm.$route.path).toBe('/other')
  })

  it('accepts an already-awaited router, for suites that need navigation settled before mount', async () => {
    const router = await createTestRouter(['/', '/_admin/:section'], '/_admin/theme')
    const { wrapper } = mountWithApp(Probe, { router })
    expect(wrapper.vm.$route.params.section).toBe('theme')
  })

  it('returns the router it installed', () => {
    const { router } = mountWithApp(Probe, { routes: ['/'] })
    expect(typeof router.push).toBe('function')
  })

  it('returns every store, seeded or not', () => {
    const result = mountWithApp(Probe)
    expect(Object.keys(result).sort()).toEqual(
      [
        'adminStore',
        'editorStore',
        'flagsStore',
        'i18n',
        'pageStore',
        'router',
        'siteStore',
        'userStore',
        'wrapper'
      ].sort()
    )
  })

  it('leaves every store untouched when `stores` is omitted', () => {
    const { siteStore, userStore, pageStore, adminStore } = mountWithApp(Probe)
    expect(siteStore.id).toBe(null)
    expect(userStore.permissions).toEqual([])
    expect(pageStore.id).toBe('')
    expect(adminStore.currentSiteId).toBe(null)
  })

  it('applies each named seed onto its store BEFORE the component mounts', () => {
    /*
      Reads the seeded values in `setup()` -- i.e. during mount, not after it. A component that
      branches on store state at setup time (which most of the pages under test do) is the case this
      ordering exists for: `Object.assign`ing the stores after `mount()` would leave it having
      already rendered the unseeded branch.
    */
    const Reader = {
      setup: () => ({ seen: `${useSiteStore().id}/${useUserStore().permissions.join(',')}` }),
      template: '<div class="seen">{{ seen }}</div>'
    }
    const { wrapper, siteStore, userStore, pageStore, adminStore, editorStore, flagsStore } =
      mountWithApp(Reader, {
        stores: {
          site: seedSite(),
          user: seedUser({ permissions: ['manage:sites'] }),
          page: seedPage({ router: stubRouter() }),
          admin: seedAdmin(),
          editor: { mode: 'edit' },
          flags: { loaded: true }
        }
      })
    // -> The component saw the seeded values as it rendered, not just afterwards.
    expect(wrapper.find('.seen').text()).toBe('site-1/manage:sites')
    expect(siteStore.id).toBe('site-1')
    expect(userStore.permissions).toEqual(['manage:sites'])
    expect(pageStore.id).toBe('page-1')
    expect(typeof pageStore.router.push).toBe('function')
    expect(adminStore.currentSiteId).toBe('site-1')
    expect(editorStore.mode).toBe('edit')
    expect(flagsStore.loaded).toBe(true)
  })

  it('runs a function seed against the store, for a nested field Object.assign cannot reach', () => {
    const { siteStore, pageStore } = mountWithApp(Probe, {
      stores: {
        site: (store) => {
          store.features.profile = true
        },
        page: (store) => store.$patch({ locale: 'fr' })
      }
    })
    expect(siteStore.features.profile).toBe(true)
    expect(pageStore.locale).toBe('fr')
  })

  it('stubs teleport by default, so a dialog renders inline where a suite can find it', () => {
    const { wrapper } = mountWithApp(Teleporting)
    expect(wrapper.find('.inside').exists()).toBe(true)
    expect(document.body.querySelector('.inside')).toBe(null)
  })

  it('lets a caller replace the default stubs, so a teleport really teleports', () => {
    const { wrapper } = mountWithApp(Teleporting, { stubs: {} })
    expect(wrapper.find('.inside').exists()).toBe(false)
    expect(document.body.querySelector('.inside')).not.toBe(null)
    wrapper.unmount()
  })

  it('registers extra components globally for the mount', () => {
    const Host = { template: '<local-thing />' }
    const { wrapper } = mountWithApp(Host, {
      components: { LocalThing: { template: '<b class="local">local</b>' } }
    })
    expect(wrapper.find('.local').text()).toBe('local')
  })

  it('attaches to the document when asked', () => {
    const { wrapper } = mountWithApp(Probe, { attachTo: document.body })
    expect(document.body.contains(wrapper.element)).toBe(true)
    wrapper.unmount()
  })

  it('forwards any other @vue/test-utils mounting option through', () => {
    const Slotted = { template: '<div class="slotted"><slot /></div>' }
    const { wrapper } = mountWithApp(Slotted, { slots: { default: '<i class="in-slot" />' } })
    expect(wrapper.find('.in-slot').exists()).toBe(true)
  })
})
