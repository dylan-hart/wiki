import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { handleListSites } from './listSites.ts'

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

/** A group whose rules grant `read:pages` everywhere -- what a non-admin "may reach a site" token holds. */
const READER_GROUP = 'reader-group'

let previousWiki: any

before(() => {
  previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = {
    sites: { [SITE_A.id]: SITE_A, [SITE_B.id]: SITE_B, [SITE_DISABLED.id]: SITE_DISABLED },
    models: {
      groups: {
        // -> Stands in for the real rule-resolution model: grants read:pages only to an actor
        //    carrying READER_GROUP, mirroring `checkAccess()`'s real signature/behavior closely
        //    enough for this tool's own gating logic to be exercised in isolation.
        checkAccess: (actor: any) => actor.groupIds.includes(READER_GROUP)
      }
    }
  }
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
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

test('handleListSites: a token that can read:pages on a site sees it, and reports the default locale', () => {
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

test('handleListSites: a site-pinned, readable token only lists its own site', () => {
  const result = handleListSites({
    keyId: 'k',
    permissions: [],
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
