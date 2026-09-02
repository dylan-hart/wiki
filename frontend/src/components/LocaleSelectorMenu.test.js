import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
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
async function mountMenu({ path, locale = 'en', forcePrefix = false }) {
  setActivePinia(createPinia())

  const siteStore = useSiteStore()
  siteStore.$patch({
    locales: { primary: 'en', showMenu: true, forcePrefix, active: LOCALES }
  })

  const pageStore = usePageStore()
  pageStore.$patch({ path, locale })

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
})
