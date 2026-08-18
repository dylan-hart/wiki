import { afterEach, describe, expect, it } from 'vitest'

import { ANALYTICS_PROVIDERS } from './analyticsProviders'

/*
  A real <script src> appended to the document is exactly what production wants -- a real load in a
  real browser. happy-dom refuses that load by design (`enableJavaScriptEvaluation: false` is its
  test-safe default) and logs a DOMException about it to its own page console rather than silently
  no-op'ing. `handleDisabledFileLoadingAsSuccess` is happy-dom's own switch for exactly this case --
  it dispatches `load` instead of logging and dispatching `error`, which is what these assertions
  actually want to observe: the DOM node's own `src`/`textContent`, not whether the browser's script
  loader accepted the (refused, in a test) fetch.
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
