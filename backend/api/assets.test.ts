import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import assetsRoutes from './assets.ts'
import { registerSchemas as registerAssetSchema } from './schemas/asset.ts'

/**
 * Regression test for task 699: the siteId-scoped asset READ routes (`GET .../assets/:assetId` and
 * `GET .../assets/:assetId/content`) trust a `siteId` the client already has cached, the same concern
 * `pages.test.ts` covers for pages. Only the two GET (read) routes are gated — upload/rename/delete
 * stay reachable so an administrator can keep cleaning up a disabled site's content, per the task.
 */

const ENABLED_SITE_ID = '11111111-1111-4111-8111-111111111111'
const DISABLED_SITE_ID = '22222222-2222-4222-8222-222222222222'
const ASSET_ID = '33333333-3333-4333-8333-333333333333'

const sites: Record<string, any> = {
  [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, isEnabled: true },
  [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, isEnabled: false }
}

let getAssetCalls = 0

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    sites,
    config: { security: {} },
    models: {
      assets: {
        getAsset: async () => {
          getAssetCalls++
          return null
        }
      },
      groups: {
        actorForRequest: () => ({ permissions: [] }),
        checkAccess: () => true
      }
    }
  }

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
  await app.register(fastifySensible)
  await registerAssetSchema(app)
  await app.register(assetsRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

test('GET asset metadata: answers 403 for a disabled site, without ever calling getAsset', async () => {
  getAssetCalls = 0
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${DISABLED_SITE_ID}/assets/${ASSET_ID}`
  })
  assert.equal(res.statusCode, 403)
  assert.match(res.json().message, /disabled/i)
  assert.equal(getAssetCalls, 0)
})

test('GET asset metadata: an enabled site reaches getAsset as before', async () => {
  getAssetCalls = 0
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${ENABLED_SITE_ID}/assets/${ASSET_ID}`
  })
  // -> 404 because getAsset is stubbed to return null, but the guard let the request get there
  assert.equal(res.statusCode, 404)
  assert.equal(getAssetCalls, 1)
})

test('DOWNLOAD asset: answers 403 for a disabled site, without ever calling getAsset', async () => {
  getAssetCalls = 0
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${DISABLED_SITE_ID}/assets/${ASSET_ID}/content`
  })
  assert.equal(res.statusCode, 403)
  assert.equal(getAssetCalls, 0)
})

test('DOWNLOAD asset: an enabled site reaches getAsset as before', async () => {
  getAssetCalls = 0
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${ENABLED_SITE_ID}/assets/${ASSET_ID}/content`
  })
  assert.equal(res.statusCode, 404)
  assert.equal(getAssetCalls, 1)
})
