import { afterEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { initializeAnalytics } from './analytics'
import { useSiteStore } from '@/stores/site'

// -> happy-dom's switch for a refused-in-test <script src> load: dispatch `load` rather than log a
//    DOMException to its page console.
window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true

afterEach(() => {
  document.head.innerHTML = ''
})

describe('initializeAnalytics', () => {
  it('injects nothing while the site store has not loaded yet', () => {
    const pinia = createPinia()
    setActivePinia(pinia)

    initializeAnalytics(pinia)

    expect(document.head.querySelectorAll('script[data-analytics-provider]')).toHaveLength(0)
  })

  it('injects an already-enabled provider immediately when the site store is already loaded', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const siteStore = useSiteStore(pinia)
    siteStore.$patch({
      id: 'site-1',
      analytics: {
        providers: { google: { isEnabled: true, config: { propertyTrackingId: 'G-X' } } }
      }
    })

    initializeAnalytics(pinia)

    expect(document.head.querySelectorAll('script[data-analytics-provider="google"]')).toHaveLength(
      2
    )
  })

  it('waits for the site store to load, then injects only the enabled providers, exactly once', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const siteStore = useSiteStore(pinia)

    initializeAnalytics(pinia)
    expect(document.head.querySelectorAll('script[data-analytics-provider]')).toHaveLength(0)

    siteStore.$patch({
      id: 'site-1',
      analytics: {
        providers: {
          google: { isEnabled: true, config: { propertyTrackingId: 'G-X' } },
          gtm: { isEnabled: false, config: { containerTrackingId: 'GTM-X' } }
        }
      }
    })
    // -> The watcher callback runs as a microtask
    await Promise.resolve()

    expect(document.head.querySelectorAll('script[data-analytics-provider="google"]')).toHaveLength(
      2
    )
    expect(document.head.querySelectorAll('script[data-analytics-provider="gtm"]')).toHaveLength(0)

    // -> The watcher stopped after its one fire, so a later SPA route change re-patching the store
    //    must NOT inject a second time.
    siteStore.$patch({
      analytics: {
        providers: { google: { isEnabled: true, config: { propertyTrackingId: 'G-X' } } }
      }
    })
    await Promise.resolve()

    expect(document.head.querySelectorAll('script[data-analytics-provider="google"]')).toHaveLength(
      2
    )
  })

  it('injects nothing when no providers are enabled', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const siteStore = useSiteStore(pinia)

    initializeAnalytics(pinia)
    siteStore.$patch({ id: 'site-1', analytics: { providers: {} } })
    await Promise.resolve()

    expect(document.head.querySelectorAll('script[data-analytics-provider]')).toHaveLength(0)
  })
})
