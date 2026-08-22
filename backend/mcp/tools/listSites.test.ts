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

let previousWiki: any

before(() => {
  previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = {
    sites: { [SITE_A.id]: SITE_A, [SITE_B.id]: SITE_B, [SITE_DISABLED.id]: SITE_DISABLED }
  }
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
})

function textOf(result: any) {
  return JSON.parse(result.content[0].text)
}

test('handleListSites: an unscoped key lists every enabled site, disabled ones excluded', () => {
  const result = handleListSites({
    keyId: 'k',
    permissions: [],
    siteId: null,
    groupIds: [],
    userId: null
  })
  const sites = textOf(result)
  assert.deepEqual(
    sites.map((s: any) => s.id),
    ['site-a', 'site-b']
  )
})

test('handleListSites: reports the default locale, falling back to en', () => {
  const result = handleListSites({
    keyId: 'k',
    permissions: [],
    siteId: null,
    groupIds: [],
    userId: null
  })
  const sites = textOf(result)
  assert.equal(sites.find((s: any) => s.id === 'site-a').defaultLocale, 'en')
  assert.equal(sites.find((s: any) => s.id === 'site-b').defaultLocale, 'en')
})

test('handleListSites: a site-scoped key only lists its own site', () => {
  const result = handleListSites({
    keyId: 'k',
    permissions: [],
    siteId: 'site-b',
    groupIds: [],
    userId: null
  })
  const sites = textOf(result)
  assert.deepEqual(
    sites.map((s: any) => s.id),
    ['site-b']
  )
})
