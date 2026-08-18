import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import App from './App.vue'
import { useSiteStore } from '@/stores/site'
import { useFlagsStore } from '@/stores/flags'
import { useUserStore } from '@/stores/user'
import { useCommonStore } from './stores/common'

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 716: `App.vue`'s
 * `applyLocale()` must set `dir`/`lang` on `<html>` for the active locale, and must do so
 * immediately -- ahead of `router.afterEach` removing `.init-loading` -- rather than waiting on the
 * (possibly slow, possibly never-resolving in this test) locale-strings fetch.
 */

beforeEach(() => {
  setActivePinia(createPinia())
  // -> Mirrors index.html's structure: router.afterEach() unconditionally removes this element
  document.body.insertAdjacentHTML('afterbegin', '<div class="init-loading"></div>')
})

afterEach(() => {
  document.documentElement.removeAttribute('dir')
  document.documentElement.removeAttribute('lang')
  document.body.innerHTML = ''
})

async function mountAppWithLocale(localeCode) {
  const siteStore = useSiteStore()
  const flagsStore = useFlagsStore()
  const userStore = useUserStore()
  const commonStore = useCommonStore()

  // -> Bootstrap already "loaded", so the router guard's loadBootstrap() branch is skipped and this
  //    hand-set locale data survives navigation untouched
  siteStore.$patch({
    id: 'site-1',
    locales: {
      primary: 'en',
      showMenu: true,
      active: [
        { code: 'en', language: 'en', name: 'English', nativeName: 'English', isRTL: false },
        { code: 'ar', language: 'ar', name: 'Arabic', nativeName: 'العربية', isRTL: true }
      ]
    }
  })
  flagsStore.loaded = true
  userStore.profileLoaded = true
  commonStore.setLocale(localeCode)

  // -> Never resolves: proves the dir/lang flip does not wait on the locale-strings request
  API_CLIENT.get.mockImplementationOnce(() => new Promise(() => {}))

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  mount(App, { global: { plugins: [router, i18n] } })

  await router.push('/')
  await router.isReady()
}

describe('App.vue applyLocale()', () => {
  it('sets dir="rtl" and lang for an RTL active locale, without waiting on locale strings', async () => {
    await mountAppWithLocale('ar')

    expect(document.documentElement.getAttribute('dir')).toBe('rtl')
    expect(document.documentElement.getAttribute('lang')).toBe('ar')
  })

  it('sets dir="ltr" for an LTR active locale', async () => {
    await mountAppWithLocale('en')

    expect(document.documentElement.getAttribute('dir')).toBe('ltr')
    expect(document.documentElement.getAttribute('lang')).toBe('en')
  })
})
