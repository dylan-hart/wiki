import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import LocaleSelectorMenu from './LocaleSelectorMenu.vue'
import WMenu from '@/components/shared/WMenu.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useDirection } from '@/composables/direction'

import { createTestI18n } from '../../test/i18n.js'
import { buildTestRouter, createTestRouter } from '../../test/router.js'

const LOCALES = [
  { code: 'en', language: 'en', name: 'English', nativeName: 'English' },
  { code: 'fr', language: 'fr', name: 'French', nativeName: 'Français' }
]

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
    // -> A real, connected element: WMenu climbs to the mounted root's own parent (see below),
    //    which is otherwise detached with no `parentElement`
    attachTo: document.body,
    global: { plugins: [router, i18n] }
  })

  /*
    WMenu's popup renders only once shown, and it climbs to the mounted root's own parent for its
    trigger. LocaleSelectorMenu has no single root node, so `wrapper.element` resolves to the div it
    mounted into -- which is that climbed trigger, and so the element the click listener sits on.
  */
  wrapper.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wrapper.vm.$nextTick()
  // -> `@show` kicks off `loadTranslationStatus()`'s fetch; let it settle before reading the menu.
  await flushPromises()
  await wrapper.vm.$nextTick()

  return { wrapper, router }
}

function findItemByText(text) {
  return [...document.querySelectorAll('.w-menu [role="button"]')].find((el) =>
    el.textContent.includes(text)
  )
}

/**
 * Runs BEFORE the describe below, deliberately: that one's wrappers are cleaned up by clearing
 * `document.body.innerHTML` rather than by `unmount()`, which leaves their instances (and their
 * watchers on the module-level `useDirection()` ref) alive -- flipping direction after any of them
 * has run re-triggers those now-parentless instances and crashes on a null `insertBefore`.
 *
 * A plain detached `mount()` is enough here: `anchor`/`self` are template-bound whether or not the
 * menu is ever opened.
 */
describe('LocaleSelectorMenu default anchor/self direction (OpenProject #3196)', () => {
  function mountDetached({ anchor, self } = {}) {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.$patch({
      id: 'site-1',
      locales: { primary: 'en', showMenu: true, forcePrefix: false, active: LOCALES }
    })
    const pageStore = usePageStore()
    pageStore.$patch({ id: 'page-1', path: 'docs/intro', locale: 'en' })

    return mount(LocaleSelectorMenu, {
      props: { ...(anchor ? { anchor } : {}), ...(self ? { self } : {}) },
      global: { plugins: [buildTestRouter(['/:pathMatch(.*)*']), createTestI18n()] }
    })
  }

  afterEach(() => {
    // -> `useDirection`'s backing ref is module-level state shared across this run; leaving it
    //    flipped would bleed into whichever test comes next
    useDirection().set(false)
  })

  it('defaults to the LTR-correct pair when no anchor/self prop is passed', () => {
    const wrapper = mountDetached()

    const menu = wrapper.findComponent(WMenu)
    expect(menu.props('anchor')).toBe('bottom left')
    expect(menu.props('self')).toBe('top left')

    wrapper.unmount()
  })

  it('mirrors the default pair under rtl', () => {
    useDirection().set(true)
    const wrapper = mountDetached()

    const menu = wrapper.findComponent(WMenu)
    expect(menu.props('anchor')).toBe('bottom right')
    expect(menu.props('self')).toBe('top right')

    wrapper.unmount()
  })

  it('re-mirrors reactively when direction flips after mount', async () => {
    const wrapper = mountDetached()
    expect(wrapper.findComponent(WMenu).props('anchor')).toBe('bottom left')

    useDirection().set(true)
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(WMenu).props('anchor')).toBe('bottom right')

    wrapper.unmount()
  })

  it('still lets a caller override anchor/self explicitly, in either direction', () => {
    useDirection().set(true)
    const wrapper = mountDetached({ anchor: 'top right', self: 'top left' })

    const menu = wrapper.findComponent(WMenu)
    expect(menu.props('anchor')).toBe('top right')
    expect(menu.props('self')).toBe('top left')

    wrapper.unmount()
  })
})

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
    // -> `pageStore.path` is always bare, never locale-prefixed, whatever locale the page was
    //    loaded in -- here the non-primary `fr`.
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
