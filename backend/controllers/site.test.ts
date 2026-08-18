import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import siteRoutes from './site.ts'

/**
 * Regression / verification coverage for `GET /_site/current/<resource>` (task 745, part 2), the
 * asset-serving counterpart of `GET /_api/sites/:siteIdorHostname`'s `strict` fix
 * (`api/sites.test.ts`). Both routes resolve a site the same way — `WIKI.models.sites
 * .getSiteByHostname({ hostname: req.hostname })` — so this suite proves that mechanism actually
 * picks the right site per-request across multiple hostnames, not just that the model function is
 * correct in isolation.
 *
 * `WIKI.models.sites.getSiteByHostname`/`getAsset` are stubbed to reproduce the real model's
 * exact/wildcard semantics (`models/sites.ts`) rather than pulling in the db/schema/drizzle graph —
 * same approach as `api/sites.test.ts`.
 */

const SITE_A = { id: 'site-a', hostname: 'sitea.example.com', config: { assets: { logo: true } } }
const SITE_B = { id: 'site-b', hostname: 'siteb.example.com', config: { assets: { logo: true } } }
const SITE_WILDCARD = { id: 'site-wildcard', hostname: '*', config: { assets: { logo: true } } }

const sitesMappings: Record<string, string> = {
  [SITE_A.hostname]: SITE_A.id,
  [SITE_B.hostname]: SITE_B.id,
  '*': SITE_WILDCARD.id
}
const sites: Record<string, any> = {
  [SITE_A.id]: SITE_A,
  [SITE_B.id]: SITE_B,
  [SITE_WILDCARD.id]: SITE_WILDCARD
}

/** Distinct bytes per site so a response can be attributed to exactly one of them. */
const assetsBySiteId: Record<string, { mime: string; data: Buffer }> = {
  [SITE_A.id]: { mime: 'image/png', data: Buffer.from('logo-a') },
  [SITE_B.id]: { mime: 'image/png', data: Buffer.from('logo-b') },
  [SITE_WILDCARD.id]: { mime: 'image/png', data: Buffer.from('logo-wildcard') }
}

async function getSiteByHostname({ hostname }: { hostname: string }) {
  // -> Mirrors the real `Sites.getSiteByHostname`'s non-strict lookup: exact match, else the '*'
  //    wildcard mapping.
  const siteId = sitesMappings[hostname] || sitesMappings['*']
  return siteId ? sites[siteId] : null
}

async function getAsset(siteId: string, _kind: string) {
  return assetsBySiteId[siteId] ?? null
}

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    ROOTPATH: process.cwd(),
    models: {
      sites: {
        getSiteByHostname,
        getSiteById: async () => null,
        getAsset
      }
    }
  }

  app = fastify()
  await app.register(siteRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

test("resolves site A's own logo when the Host header is site A's hostname", async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/current/logo',
    headers: { host: SITE_A.hostname }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, 'logo-a')
})

test("resolves site B's own logo when the Host header is site B's hostname", async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/current/logo',
    headers: { host: SITE_B.hostname }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, 'logo-b')
})

test("falls back to the '*' wildcard site when no site is registered for the hostname", async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/current/logo',
    headers: { host: 'unregistered.example.com' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, 'logo-wildcard')
})

test(
  "a Host header carrying a port still resolves the bare-hostname site, not the '*' wildcard " +
    "(Fastify's req.hostname already strips the port before this route ever sees it)",
  async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/current/logo',
      headers: { host: `${SITE_A.hostname}:3000` }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, 'logo-a')
  }
)
