import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { McpToolError } from './auth.ts'
import { resolveDefaultSiteId, resolveRequestedSite, resolveSite } from './site.ts'
import { installTestWiki } from '../test/mocks.ts'

const SITE_A = { id: 'site-a', hostname: 'a.example.com', isEnabled: true, config: {} }
const SITE_B = { id: 'site-b', hostname: 'b.example.com', isEnabled: true, config: {} }
const SITE_DISABLED = { id: 'site-c', hostname: 'c.example.com', isEnabled: false, config: {} }

let wikiHandle: { restore(): void }

function installSites(sites: Record<string, any>) {
  wikiHandle = installTestWiki({ sites })
}

after(() => {
  wikiHandle.restore()
})

test('resolveSite: returns the site when it exists and is enabled', () => {
  installSites({ [SITE_A.id]: SITE_A })
  assert.deepEqual(resolveSite('site-a'), SITE_A)
})

test('resolveSite: throws when the site does not exist', () => {
  installSites({})
  assert.throws(() => resolveSite('missing'), McpToolError)
})

test('resolveSite: throws when the site is disabled', () => {
  installSites({ [SITE_DISABLED.id]: SITE_DISABLED })
  assert.throws(() => resolveSite('site-c'), /disabled/)
})

// -> No `defaultLocale` tests here any more: `mcp/` had its own copy of the same
//    `config.locales.primary ?? 'en'` fallback, and now calls `helpers/common.ts#defaultLocale`,
//    whose own cases live in `helpers/common.test.ts`.

test('resolveDefaultSiteId: a site-pinned key always resolves to its own site', () => {
  installSites({ [SITE_A.id]: SITE_A, [SITE_B.id]: SITE_B })
  assert.equal(
    resolveDefaultSiteId({
      keyId: 'k',
      permissions: [],
      siteId: 'site-b',
      groupIds: [],
      userId: null,
      scope: null
    }),
    'site-b'
  )
})

test('resolveDefaultSiteId: an unscoped key resolves to the sole enabled site', () => {
  installSites({ [SITE_A.id]: SITE_A, [SITE_DISABLED.id]: SITE_DISABLED })
  assert.equal(
    resolveDefaultSiteId({
      keyId: 'k',
      permissions: [],
      siteId: null,
      groupIds: [],
      userId: null,
      scope: null
    }),
    'site-a'
  )
})

test('resolveDefaultSiteId: an unscoped key resolves to nothing when several sites are enabled', () => {
  installSites({ [SITE_A.id]: SITE_A, [SITE_B.id]: SITE_B })
  assert.equal(
    resolveDefaultSiteId({
      keyId: 'k',
      permissions: [],
      siteId: null,
      groupIds: [],
      userId: null,
      scope: null
    }),
    null
  )
})

test('resolveRequestedSite: an explicit siteId wins over the default guess', () => {
  installSites({ [SITE_A.id]: SITE_A, [SITE_B.id]: SITE_B })
  assert.deepEqual(
    resolveRequestedSite(
      { keyId: 'k', permissions: [], siteId: null, groupIds: [], userId: null, scope: null },
      'site-b'
    ),
    SITE_B
  )
})

test('resolveRequestedSite: refuses when neither an explicit siteId nor a default settles on one', () => {
  installSites({ [SITE_A.id]: SITE_A, [SITE_B.id]: SITE_B })
  assert.throws(
    () =>
      resolveRequestedSite({
        keyId: 'k',
        permissions: [],
        siteId: null,
        groupIds: [],
        userId: null,
        scope: null
      }),
    /more than one site/
  )
})

test('resolveRequestedSite: enforces the key site-pin even when an explicit siteId is given', () => {
  installSites({ [SITE_A.id]: SITE_A, [SITE_B.id]: SITE_B })
  assert.throws(
    () =>
      resolveRequestedSite(
        { keyId: 'k', permissions: [], siteId: 'site-a', groupIds: [], userId: null, scope: null },
        'site-b'
      ),
    /not scoped/
  )
})
