import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { sites } from './sites.ts'

/**
 * Regression test for task 702: `getSiteByHostname`'s precedence — an exact hostname match beats the
 * `*` catch-all, and `strict: true` excludes the catch-all fallback entirely — is what the
 * `api/sites.test.ts` "strict=true does not fall back" tests exercise end-to-end through a stubbed
 * copy of this same logic. This file exercises the real model method directly instead, against a
 * fake `WIKI.sites` / `WIKI.sitesMappings` (exactly what `reloadCache` populates), with no database:
 * `getSiteByHostname` with `forceReload: false` (the default) touches nothing but those two in-memory
 * maps.
 */

const EXACT_SITE_ID = 'exact-site-id'
const WILDCARD_SITE_ID = 'wildcard-site-id'

before(() => {
  ;(globalThis as any).WIKI = {
    sites: {
      [EXACT_SITE_ID]: { id: EXACT_SITE_ID, hostname: 'wiki.example.com', isEnabled: true },
      [WILDCARD_SITE_ID]: { id: WILDCARD_SITE_ID, hostname: '*', isEnabled: true }
    },
    sitesMappings: {
      'wiki.example.com': EXACT_SITE_ID,
      '*': WILDCARD_SITE_ID
    }
  }
})

after(() => {
  delete (globalThis as any).WIKI
})

describe('sites.getSiteByHostname', () => {
  test('an exact hostname match beats the catch-all', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'wiki.example.com' })
    assert.equal(site?.id, EXACT_SITE_ID)
  })

  test('an unmapped hostname falls back to the catch-all when not strict', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'unmapped.example.com', strict: false })
    assert.equal(site?.id, WILDCARD_SITE_ID)
  })

  test('strict: true excludes the catch-all fallback for an unmapped hostname', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'unmapped.example.com', strict: true })
    assert.equal(site, null)
  })

  test('strict: true still returns an exact match', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'wiki.example.com', strict: true })
    assert.equal(site?.id, EXACT_SITE_ID)
  })
})
