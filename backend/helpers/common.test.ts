import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRequestSite } from './common.ts'

const ENABLED_SITE_ID = 'enabled-site-id'
const DISABLED_SITE_ID = 'disabled-site-id'
const WILDCARD_SITE_ID = 'wildcard-site-id'

const sites: Record<string, any> = {
  [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, hostname: 'wiki.example.com', isEnabled: true },
  [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, hostname: 'off.example.com', isEnabled: false },
  [WILDCARD_SITE_ID]: { id: WILDCARD_SITE_ID, hostname: '*', isEnabled: true }
}

const sitesMappings: Record<string, string> = {
  'wiki.example.com': ENABLED_SITE_ID,
  'off.example.com': DISABLED_SITE_ID,
  '*': WILDCARD_SITE_ID
}

const NO_EXEMPT_SEGMENTS = new Set<string>()
const LOGIN_EXEMPT = new Set(['login'])

describe('resolveRequestSite', () => {
  test('resolves an enabled site to "ok" with the site attached', () => {
    const result = resolveRequestSite({
      firstSegment: 'some-page',
      hostname: 'wiki.example.com',
      sitesMappings,
      sites,
      exemptSegments: NO_EXEMPT_SEGMENTS
    })
    assert.deepEqual(result, { outcome: 'ok', site: sites[ENABLED_SITE_ID] })
  })

  test('falls back to the wildcard mapping when the hostname has no exact match, same precedence as the SEO hook', () => {
    const result = resolveRequestSite({
      firstSegment: 'some-page',
      hostname: 'unmapped.example.com',
      sitesMappings,
      sites,
      exemptSegments: NO_EXEMPT_SEGMENTS
    })
    assert.deepEqual(result, { outcome: 'ok', site: sites[WILDCARD_SITE_ID] })
  })

  test('reports "not-found" when neither the hostname nor a wildcard mapping exists', () => {
    const result = resolveRequestSite({
      firstSegment: 'some-page',
      hostname: 'unmapped.example.com',
      sitesMappings: { 'wiki.example.com': ENABLED_SITE_ID },
      sites,
      exemptSegments: NO_EXEMPT_SEGMENTS
    })
    assert.deepEqual(result, { outcome: 'not-found' })
  })

  test('distinguishes "disabled" from "not-found" for a resolved-but-disabled site', () => {
    const result = resolveRequestSite({
      firstSegment: 'some-page',
      hostname: 'off.example.com',
      sitesMappings,
      sites,
      exemptSegments: NO_EXEMPT_SEGMENTS
    })
    assert.deepEqual(result, { outcome: 'disabled', site: sites[DISABLED_SITE_ID] })
  })

  test('lets an exempt first segment through regardless of the site being disabled', () => {
    const result = resolveRequestSite({
      firstSegment: 'login',
      hostname: 'off.example.com',
      sitesMappings,
      sites,
      exemptSegments: LOGIN_EXEMPT
    })
    assert.deepEqual(result, { outcome: 'exempt' })
  })

  test('lets an exempt first segment through regardless of the hostname matching no site at all', () => {
    const result = resolveRequestSite({
      firstSegment: 'login',
      hostname: 'unmapped.example.com',
      sitesMappings: { 'wiki.example.com': ENABLED_SITE_ID },
      sites,
      exemptSegments: LOGIN_EXEMPT
    })
    assert.deepEqual(result, { outcome: 'exempt' })
  })
})
