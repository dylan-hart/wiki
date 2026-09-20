import { afterEach, describe, expect, it } from 'vitest'

import { ANALYTICS_PROVIDERS } from './analyticsProviders'

/*
  happy-dom refuses to load a real <script src> by design and logs a DOMException for it.
  `handleDisabledFileLoadingAsSuccess` makes it dispatch `load` instead, which is all these
  assertions need: they read the DOM node's own `src`/`textContent`, not whether a script loader
  accepted the fetch.
*/
window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true

afterEach(() => {
  document.head.innerHTML = ''
})

describe('ANALYTICS_PROVIDERS', () => {
  it('google appends a gtag.js loader script and a config script, parameterized by propertyTrackingId', () => {
    ANALYTICS_PROVIDERS.google.inject({ propertyTrackingId: 'G-TEST123' })

    const scripts = document.head.querySelectorAll('script[data-analytics-provider="google"]')
    expect(scripts).toHaveLength(2)
    expect(scripts[0].src).toBe('https://www.googletagmanager.com/gtag/js?id=G-TEST123')
    expect(scripts[0].async).toBe(true)
    expect(scripts[1].textContent).toContain('gtag(\'config\', "G-TEST123")')
  })

  it('google injects nothing without a propertyTrackingId', () => {
    ANALYTICS_PROVIDERS.google.inject({})
    expect(document.head.querySelectorAll('script')).toHaveLength(0)
  })

  it('gtm appends its inline loader script, parameterized by containerTrackingId', () => {
    ANALYTICS_PROVIDERS.gtm.inject({ containerTrackingId: 'GTM-TEST' })

    const scripts = document.head.querySelectorAll('script[data-analytics-provider="gtm"]')
    expect(scripts).toHaveLength(1)
    expect(scripts[0].textContent).toContain("'https://www.googletagmanager.com/gtm.js?id='+i+dl")
    expect(scripts[0].textContent).toContain('"GTM-TEST"')
  })

  it('gtm injects nothing without a containerTrackingId', () => {
    ANALYTICS_PROVIDERS.gtm.inject({})
    expect(document.head.querySelectorAll('script')).toHaveLength(0)
  })

  it('matomo appends its tracker bootstrap script, parameterized by siteId and serverHost', () => {
    ANALYTICS_PROVIDERS.matomo.inject({ siteId: 3, serverHost: 'https://example.matomo.cloud/' })

    const scripts = document.head.querySelectorAll('script[data-analytics-provider="matomo"]')
    expect(scripts).toHaveLength(1)
    expect(scripts[0].textContent).toContain('"https://example.matomo.cloud/"')
    expect(scripts[0].textContent).toContain('setSiteId\', "3"')
  })

  it('matomo injects nothing without both siteId and serverHost', () => {
    ANALYTICS_PROVIDERS.matomo.inject({ siteId: 1 })
    expect(document.head.querySelectorAll('script')).toHaveLength(0)
  })
})
