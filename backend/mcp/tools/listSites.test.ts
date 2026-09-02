import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { handleListSites } from './listSites.ts'
import { installTestWiki } from '../../test/mocks.ts'

const SITE_A = {
  id: 'site-a',
  hostname: 'a.example.com',
  isEnabled: true,
  config: { title: 'Site A', locales: { primary: 'en' } }
}
const SITE_B = {
  id: 'site-b',
  hostname: 'b.example.com',
  isEnabled: true,
  config: { title: 'Site B' }
}
const SITE_DISABLED = {
  id: 'site-c',
  hostname: 'c.example.com',
  isEnabled: false,
  config: { title: 'Site C' }
}

/** A groupId used by the tests below to stand in for "some group a token belongs to". */
const READER_GROUP = 'reader-group'

let wikiHandle: { restore(): void }
const checkAccess = mock.fn((_actor: any, _permission: string, _page: any) => false)

before(() => {
  wikiHandle = installTestWiki({
    sites: { [SITE_A.id]: SITE_A, [SITE_B.id]: SITE_B, [SITE_DISABLED.id]: SITE_DISABLED },
    models: { groups: { checkAccess } }
  })
})

after(() => {
  wikiHandle.restore()
})

beforeEach(() => {
  checkAccess.mock.resetCalls()
  checkAccess.mock.mockImplementation((_actor: any, _permission: string, _page: any) => false)
})

function textOf(result: any) {
  return JSON.parse(result.content[0].text)
}

test('handleListSites: a token whose groups grant nothing sees an empty list', () => {
  const result = handleListSites({
    keyId: 'k',
    permissions: [],
    siteId: null,
    groupIds: [],
    userId: null,
    scope: null
  })
  assert.deepEqual(textOf(result), [])
})

test('handleListSites: an access:admin token sees every enabled site, disabled ones excluded', () => {
  const result = handleListSites({
    keyId: 'k',
    permissions: ['access:admin'],
    siteId: null,
    groupIds: [],
    userId: null,
    scope: null
  })
  const sites = textOf(result)
  assert.deepEqual(
    sites.map((s: any) => s.id),
    ['site-a', 'site-b']
  )
  // -> access:admin short-circuits before any page-rule check is even made
  assert.equal(checkAccess.mock.callCount(), 0)
})

test('handleListSites: a manage:sites token sees every enabled site', () => {
  const result = handleListSites({
    keyId: 'k',
    permissions: ['manage:sites'],
    siteId: null,
    groupIds: [],
    userId: null,
    scope: null
  })
  const sites = textOf(result)
  assert.deepEqual(
    sites.map((s: any) => s.id),
    ['site-a', 'site-b']
  )
})

test('handleListSites: a token with no global permission but read:pages on one site sees only that site', () => {
  checkAccess.mock.mockImplementation(
    (_actor: any, _permission: string, page: any) => page.siteId === 'site-b'
  )
  const result = handleListSites({
    keyId: 'k',
    permissions: [],
    siteId: null,
    groupIds: [READER_GROUP],
    userId: null,
    scope: null
  })
  const sites = textOf(result)
  assert.deepEqual(
    sites.map((s: any) => s.id),
    ['site-b']
  )
})

test('handleListSites: reports the default locale, falling back to en', () => {
  checkAccess.mock.mockImplementation((_actor: any, _permission: string, _page: any) => true)
  const result = handleListSites({
    keyId: 'k',
    permissions: [],
    siteId: null,
    groupIds: [READER_GROUP],
    userId: null,
    scope: null
  })
  const sites = textOf(result)
  assert.deepEqual(
    sites.map((s: any) => s.id),
    ['site-a', 'site-b']
  )
  assert.equal(sites.find((s: any) => s.id === 'site-a').defaultLocale, 'en')
  assert.equal(sites.find((s: any) => s.id === 'site-b').defaultLocale, 'en')
})

test('handleListSites: a site-scoped token still sees only its pinned site, even with access:admin', () => {
  const result = handleListSites({
    keyId: 'k',
    permissions: ['access:admin'],
    siteId: 'site-b',
    groupIds: [READER_GROUP],
    userId: null,
    scope: null
  })
  const sites = textOf(result)
  assert.deepEqual(
    sites.map((s: any) => s.id),
    ['site-b']
  )
})

test('handleListSites: a site-scoped token with no other access sees nothing, even for its pinned site', () => {
  const result = handleListSites({
    keyId: 'k',
    permissions: [],
    siteId: 'site-b',
    groupIds: [],
    userId: null,
    scope: null
  })
  assert.deepEqual(textOf(result), [])
})
