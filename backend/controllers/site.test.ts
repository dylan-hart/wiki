import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import siteRoutes from './site.ts'

/**
 * Regression test for task 699: `/_site/:siteId/:resource` (logo/favicon/login background) resolves
 * its own siteId independently of the page/shell hook in `index.ts`, so a disabled site's images
 * stayed reachable by direct URL forever. Asserts the same contract as `api/bootstrap.test.ts` — a
 * disabled site answers 403, distinguishable from the pre-existing 404 for a siteId/hostname that
 * matches nothing.
 */

const ENABLED_SITE_ID = '11111111-1111-4111-8111-111111111111'
const DISABLED_SITE_ID = '22222222-2222-4222-8222-222222222222'

const sites: Record<string, any> = {
  [ENABLED_SITE_ID]: {
    id: ENABLED_SITE_ID,
    hostname: 'wiki.example.com',
    isEnabled: true,
    // -> An upload already on file, so the enabled-site test exercises the guard passing the request
    //    through to the served-bytes branch rather than the on-disk fallback file, which this test
    //    environment has no built `assets/` directory to serve
    config: { assets: { logo: true } }
  },
  [DISABLED_SITE_ID]: {
    id: DISABLED_SITE_ID,
    hostname: 'off.example.com',
    isEnabled: false,
    config: { assets: {} }
  }
}

async function getSiteById({ id }: { id: string }) {
  return sites[id] ?? null
}

async function getAsset(siteId: string, kind: string) {
  return sites[siteId]?.config?.assets?.[kind]
    ? { data: Buffer.from('fake-logo-bytes'), mime: 'image/webp' }
    : null
}

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    ROOTPATH: process.cwd(),
    models: {
      sites: { getSiteById, getSiteByHostname: async () => null, getAsset }
    }
  }
  app = fastify()
  await app.register(fastifySensible)
  await app.register(siteRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

test('answers 404 for a siteId that matches nothing', async () => {
  const res = await app.inject({ method: 'GET', url: '/00000000-0000-0000-0000-000000000000/logo' })
  assert.equal(res.statusCode, 404)
})

test('answers 403, distinguishable from 404, for a resolved-but-disabled site', async () => {
  const res = await app.inject({ method: 'GET', url: `/${DISABLED_SITE_ID}/logo` })
  assert.equal(res.statusCode, 403)
  assert.notEqual(res.statusCode, 404)
  assert.match(res.json().message, /disabled/i)
})

test('an enabled site serves its uploaded asset, past the guard', async () => {
  const res = await app.inject({ method: 'GET', url: `/${ENABLED_SITE_ID}/logo` })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, 'fake-logo-bytes')
})
