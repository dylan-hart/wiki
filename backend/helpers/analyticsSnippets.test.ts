import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { analyticsShellFragments, ANALYTICS_SNIPPET_BUILDERS } from './analyticsSnippets.ts'

function enabled(key: string, config: Record<string, unknown>) {
  return { providers: { [key]: { isEnabled: true, config } } }
}

describe('analyticsShellFragments', () => {
  test('nothing configured, or nothing enabled, adds nothing', () => {
    assert.deepEqual(analyticsShellFragments(undefined), {})
    assert.deepEqual(analyticsShellFragments({ providers: {} }), {})
    assert.deepEqual(
      analyticsShellFragments({
        providers: { google: { isEnabled: false, config: { propertyTrackingId: 'G-1' } } }
      }),
      {}
    )
  })

  test('an enabled provider with a missing required value adds nothing', () => {
    assert.deepEqual(analyticsShellFragments(enabled('google', {})), {})
    assert.deepEqual(analyticsShellFragments(enabled('gtm', { containerTrackingId: '' })), {})
    assert.deepEqual(analyticsShellFragments(enabled('matomo', { siteId: '1' })), {})
    assert.deepEqual(
      analyticsShellFragments(enabled('matomo', { serverHost: 'https://m.test' })),
      {}
    )
  })

  test('an enabled provider with no config object adds nothing rather than throwing', () => {
    assert.deepEqual(analyticsShellFragments({ providers: { google: { isEnabled: true } } }), {})
  })

  test('a key with no builder is skipped, including inherited object keys', () => {
    assert.deepEqual(analyticsShellFragments(enabled('plausible', { domain: 'x' })), {})
    assert.deepEqual(analyticsShellFragments(enabled('toString', {})), {})
    assert.deepEqual(analyticsShellFragments(enabled('constructor', {})), {})
  })

  describe('google', () => {
    test('renders the loader and the config call into the head fragment', () => {
      const { head, bodyEnd } = analyticsShellFragments(
        enabled('google', { propertyTrackingId: 'G-ABC123' })
      )
      assert.equal(bodyEnd, undefined)
      assert.ok(
        head!.includes(
          '<script data-analytics-provider="google" async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>'
        )
      )
      assert.ok(head!.includes(`gtag('config', "G-ABC123");`))
    })

    test('the id is URL-encoded in the src and escaped as a JS string in the body', () => {
      const evil = `"><script>alert(1)</script>&x='`
      const { head } = analyticsShellFragments(enabled('google', { propertyTrackingId: evil }))
      assert.ok(head!.includes(`id=${encodeURIComponent(evil).replace(/'/g, '&#39;')}"`))
      assert.equal(head!.match(/<script/g)!.length, 2)
      assert.equal(head!.match(/<\/script>/g)!.length, 2)
      assert.ok(head!.includes('\\u003cscript>alert(1)\\u003c/script>'))
    })
  })

  describe('gtm', () => {
    test('renders the container bootstrap with the id as a JS string literal', () => {
      const { head } = analyticsShellFragments(enabled('gtm', { containerTrackingId: 'GTM-XY12' }))
      assert.ok(head!.startsWith('<script data-analytics-provider="gtm">'))
      assert.ok(head!.endsWith(`'dataLayer',"GTM-XY12");</script>`))
    })

    test('a value containing </script cannot close the element', () => {
      const { head } = analyticsShellFragments(
        enabled('gtm', { containerTrackingId: '</script><img src=x onerror=alert(1)>' })
      )
      assert.equal(head!.match(/<\/script/gi)!.length, 1)
      assert.ok(!head!.includes('<img'))
    })

    test('U+2028 and U+2029 are escaped, not emitted raw', () => {
      const { head } = analyticsShellFragments(
        enabled('gtm', { containerTrackingId: 'a\u2028b\u2029c' })
      )
      assert.ok(!head!.includes('\u2028'))
      assert.ok(!head!.includes('\u2029'))
      assert.ok(head!.includes('a\\u2028b\\u2029c'))
    })
  })

  describe('matomo', () => {
    test('renders the tracker with trailing slashes on the host collapsed to one', () => {
      const { head } = analyticsShellFragments(
        enabled('matomo', { siteId: '7', serverHost: 'https://example.matomo.cloud///' })
      )
      assert.ok(head!.includes('var u = "https://example.matomo.cloud/";'))
      assert.ok(head!.includes(`_paq.push(['setSiteId', "7"]);`))
      assert.ok(head!.includes('data-analytics-provider="matomo"'))
    })

    test('a numeric siteId is rendered as the same string the client sends', () => {
      const { head } = analyticsShellFragments(
        enabled('matomo', { siteId: 1, serverHost: 'https://m.test' })
      )
      assert.ok(head!.includes(`_paq.push(['setSiteId', "1"]);`))
    })

    test('markup in either value stays inside a JS string', () => {
      const { head } = analyticsShellFragments(
        enabled('matomo', { siteId: '1</script><b>', serverHost: 'https://m.test/</script><i>' })
      )
      assert.equal(head!.match(/<\/script/gi)!.length, 1)
      assert.ok(!head!.includes('<b>'))
      assert.ok(!head!.includes('<i>'))
    })
  })

  test('several enabled providers render in config order, disabled ones between are skipped', () => {
    const { head } = analyticsShellFragments({
      providers: {
        gtm: { isEnabled: true, config: { containerTrackingId: 'GTM-1' } },
        google: { isEnabled: false, config: { propertyTrackingId: 'G-1' } },
        matomo: { isEnabled: true, config: { siteId: '2', serverHost: 'https://m.test' } }
      }
    })
    assert.ok(head!.indexOf('provider="gtm"') < head!.indexOf('provider="matomo"'))
    assert.ok(!head!.includes('provider="google"'))
  })

  test('an injected builder map is what decides which providers render', () => {
    const { head } = analyticsShellFragments(enabled('demo', { a: 1 }), {
      demo: () => '<script data-analytics-provider="demo"></script>'
    })
    assert.equal(head, '<script data-analytics-provider="demo"></script>')
  })
})

describe('ANALYTICS_SNIPPET_BUILDERS', () => {
  test('has exactly the providers whose client builders it replaces', () => {
    assert.deepEqual(Object.keys(ANALYTICS_SNIPPET_BUILDERS).sort(), ['google', 'gtm', 'matomo'])
  })
})
