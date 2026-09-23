import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import App from './App.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../test/i18n.js'
import { buildTestRouter } from '../test/router.js'

let currentWrapper

beforeEach(() => {
  Object.assign(window.happyDOM.settings, {
    disableCSSFileLoading: true,
    handleDisabledFileLoadingAsSuccess: true
  })
  setActivePinia(createPinia())
  document.body.insertAdjacentHTML('afterbegin', '<div class="init-loading"></div>')
})

afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = undefined
  document.documentElement.removeAttribute('dir')
  document.documentElement.removeAttribute('lang')
  document.body.innerHTML = ''
})

async function mountAt(path) {
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  useFlagsStore().loaded = true
  const userStore = useUserStore()
  userStore.profileLoaded = true
  userStore.authenticated = true

  const router = buildTestRouter(['/:pathMatch(.*)*'])
  const i18n = createTestI18n({
    profile: { authConnectSuccess: 'Sign-in method connected.' }
  })
  currentWrapper = mount(App, { global: { plugins: [router, i18n] } })
  await router.push(path)
  await router.isReady()
  await flushPromises()
  return { router, siteStore }
}

describe('App.vue sign-in method link result', () => {
  it('handles the connect callback parameters once the navigation lands', async () => {
    const { router, siteStore } = await mountAt('/some/page?authLink=added&strategyId=strat-1')

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: 'Sign-in method connected.'
    })
    expect(siteStore.overlay).toBe('Profile')
    expect(siteStore.overlayOpts).toEqual({ section: 'auth' })
    expect(router.currentRoute.value.fullPath).toBe('/some/page')
  })

  it('leaves an ordinary navigation alone', async () => {
    const { router, siteStore } = await mountAt('/some/page?tab=x')

    expect(siteStore.overlay).not.toBe('Profile')
    expect(router.currentRoute.value.fullPath).toBe('/some/page?tab=x')
  })
})
