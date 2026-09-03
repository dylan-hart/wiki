import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import LocaleSelectorMenu from './LocaleSelectorMenu.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

const LOCALES = [
  { code: 'en', language: 'en', name: 'English', nativeName: 'English' },
  { code: 'fr', language: 'fr', name: 'French', nativeName: 'Français' }
]

/**
 * Regression coverage for the click handler that used to be `commonStore.setLocale(lang.code)` --
 * see the doc comment on `switchLocale` in `LocaleSelectorMenu.vue` for what that got wrong and why
 * this replaces it with navigation.
 */
async function mountMenu({ path, locale = 'en', forcePrefix = false, id = 'page-1' }) {
  setActivePinia(createPinia())

  const siteStore = useSiteStore()
  siteStore.$patch({
    id: 'site-1',
    locales: { primary: 'en', showMenu: true, forcePrefix, active: LOCALES }
  })

  const pageStore = usePageStore()
  pageStore.$patch({ id, path, locale })

  const router = await createTestRouter(['/:pathMatch(.*)*'], `/${path}`)

  const i18n = createTestI18n()

  const wrapper = mount(LocaleSelectorMenu, {
    // -> `attachTo` a real, connected element: WMenu's trigger is climbed from the mounted root's
    //    OWN parent (see below), which vue-test-utils otherwise leaves detached with no parentElement
    attachTo: document.body,
    global: { plugins: [router, i18n] }
  })

  /*
    WMenu's popup only renders once shown. Its trigger is climbed from the mounted root's own
    parent (see `onMounted` in WMenu.vue) -- normally the enclosing WBtn. LocaleSelectorMenu has no
    single root node (a hidden placeholder span plus a teleport), so vue-test-utils' `wrapper.element`
    itself resolves to the div it mounted into (see the comment on that in vite.config.js) -- which is
    exactly WMenu's climbed trigger, so this dispatches on the element the real click listener sits on
    rather than one further up that a bubbling click would never reach it from.
  */
  wrapper.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wrapper.vm.$nextTick()
  // -> `@show` kicks off `loadTranslationStatus()`'s async fetch; let it settle before a test reads
  //    the rendered menu, same as `App.locale.test.js`'s own `flushPromises()` convention.
  await flushPromises()
  await wrapper.vm.$nextTick()

  return { wrapper, router }
}

function findItemByText(text) {
  return [...document.querySelectorAll('.w-menu [role="button"]')].find((el) =>
    el.textContent.includes(text)
  )
}

describe('LocaleSelectorMenu', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('navigates to the current page re-prefixed for the chosen locale, instead of only switching the UI language', async () => {
    const { router } = await mountMenu({ path: 'docs/intro', locale: 'en' })
    const pushSpy = vi.spyOn(router, 'push')

    findItemByText('Français').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(pushSpy).toHaveBeenCalledWith('/fr/docs/intro')
  })

  it('leaves the primary locale unprefixed when forcePrefix is off', async () => {
    // -> `pageStore.path` is always bare, never locale-prefixed -- see `parseLocalePrefix` --
    //    whatever locale the page was loaded in, here the non-primary `fr`.
    const { router } = await mountMenu({ path: 'docs/intro', locale: 'fr' })
    const pushSpy = vi.spyOn(router, 'push')

    findItemByText('English').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(pushSpy).toHaveBeenCalledWith('/docs/intro')
  })

  it('prefixes the primary locale too when forcePrefix is on', async () => {
    const { router } = await mountMenu({ path: 'docs/intro', locale: 'en', forcePrefix: true })
    const pushSpy = vi.spyOn(router, 'push')

    findItemByText('English').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(pushSpy).toHaveBeenCalledWith('/en/docs/intro')
  })

  describe('staleness/missing badge (OpenProject #2475)', () => {
    it('fetches translation status for the current page once the menu opens', async () => {
      API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })

      await mountMenu({ path: 'docs/intro', locale: 'en', id: 'page-42' })

      expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/page-42/translationStatus')
    })

    it('badges a locale whose translation predates the primary', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () =>
          Promise.resolve([
            { locale: 'en', exists: true, stale: false },
            { locale: 'fr', exists: true, stale: true }
          ])
      })

      await mountMenu({ path: 'docs/intro', locale: 'en' })

      expect(findItemByText('English').querySelector('.w-badge')).toBeFalsy()
      expect(findItemByText('Français').querySelector('.w-badge')).toBeTruthy()
    })

    it('badges a locale with no translation at all, the same as a stale one', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () =>
          Promise.resolve([
            { locale: 'en', exists: true, stale: false },
            { locale: 'fr', exists: false, stale: false }
          ])
      })

      await mountMenu({ path: 'docs/intro', locale: 'en' })

      expect(findItemByText('Français').querySelector('.w-badge')).toBeTruthy()
    })

    it('never badges the primary locale against itself', async () => {
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve([{ locale: 'en', exists: true, stale: false }])
      })

      await mountMenu({ path: 'docs/intro', locale: 'en' })

      expect(findItemByText('English').querySelector('.w-badge')).toBeFalsy()
    })

    it('never fetches for a page that has no id yet (mid-creation)', async () => {
      await mountMenu({ path: 'docs/intro', locale: 'en', id: '' })

      expect(API_CLIENT.get).not.toHaveBeenCalled()
      expect(findItemByText('Français').querySelector('.w-badge')).toBeFalsy()
    })

    it('leaves every item unbadged when the fetch fails, rather than throwing', async () => {
      API_CLIENT.get.mockImplementationOnce(() => {
        throw new Error('network')
      })

      await mountMenu({ path: 'docs/intro', locale: 'en' })

      expect(findItemByText('English').querySelector('.w-badge')).toBeFalsy()
      expect(findItemByText('Français').querySelector('.w-badge')).toBeFalsy()
    })
  })
})
