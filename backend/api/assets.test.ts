import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import assetsRoutes, { mayOnAsset } from './assets.ts'
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

/**
 * Regression tests for task 676: `mayOnAsset` takes an explicit `siteId` and threads it into the
 * `RulePageRef` passed to `checkAccess`, so a page rule scoped to one site (task 671) is enforced
 * for assets, not just pages. Exercised directly, plus one route wiring check per call site that can
 * reach `mayOnAsset` without extra session setup (upload requires an authenticated session and is
 * covered indirectly by the direct `mayOnAsset` test instead).
 */

test('mayOnAsset: threads siteId into the RulePageRef passed to checkAccess', () => {
  const calls: any[] = []
  const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => {
    calls.push(page)
    return true
  }
  try {
    const result = mayOnAsset({} as any, 'read:assets', ENABLED_SITE_ID, {
      folderPath: 'foo',
      fileName: 'bar.png'
    })
    assert.equal(result, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].siteId, ENABLED_SITE_ID)
    assert.equal(calls[0].path, 'foo/bar.png')
  } finally {
    ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
  }
})

test('GET asset metadata route: passes the route siteId through to checkAccess', async () => {
  const calls: any[] = []
  const originalGetAsset = (globalThis as any).WIKI.models.assets.getAsset
  const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
  ;(globalThis as any).WIKI.models.assets.getAsset = async () => ({
    folderPath: 'foo',
    fileName: 'bar.png'
  })
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => {
    calls.push(page)
    return true
  }
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${ENABLED_SITE_ID}/assets/${ASSET_ID}`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].siteId, ENABLED_SITE_ID)
  } finally {
    ;(globalThis as any).WIKI.models.assets.getAsset = originalGetAsset
    ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
  }
})

test('DELETE asset route: passes the route siteId through to checkAccess', async () => {
  const calls: any[] = []
  const originalGetAsset = (globalThis as any).WIKI.models.assets.getAsset
  const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
  const originalDeleteAsset = (globalThis as any).WIKI.models.assets.deleteAsset
  ;(globalThis as any).WIKI.models.assets.getAsset = async () => ({
    folderPath: 'foo',
    fileName: 'bar.png'
  })
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => {
    calls.push(page)
    return false
  }
  ;(globalThis as any).WIKI.models.assets.deleteAsset = async () => true
  try {
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${ENABLED_SITE_ID}/assets/${ASSET_ID}`
    })
    assert.equal(res.statusCode, 403)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].siteId, ENABLED_SITE_ID)
  } finally {
    ;(globalThis as any).WIKI.models.assets.getAsset = originalGetAsset
    ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
    ;(globalThis as any).WIKI.models.assets.deleteAsset = originalDeleteAsset
  }
})
