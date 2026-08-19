import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import { registerSchemas } from './schemas/asset.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import routes, { mayOnAsset } from './assets.ts'

describe('download route: byte-serving behavior', () => {
  /**
   * Exercises `/sites/:siteId/assets/:assetId/content` at the HTTP layer via `app.inject()`,
   * mirroring `controllers/files.test.ts` for the public route: `readContent()`'s own
   * streaming/directAccess branching is covered at the model level in `models/assets.test.ts`, so
   * this proves only what this task changed at the route layer — that `Content-Disposition` and
   * `X-Content-Type-Options` are set exactly the same way whichever kind of result `readContent()`
   * hands back, and that a `redirectUrl` short-circuits to a 302 before any of them are touched.
   */
  const siteId = '11111111-1111-1111-1111-111111111111'
  const assetId = '22222222-2222-2222-2222-222222222222'

  const asset = {
    id: assetId,
    fileName: 'archive.zip',
    fileExt: 'zip',
    kind: 'other',
    mimeType: 'application/zip',
    fileSize: 9,
    folderPath: 'docs',
    title: 'archive',
    hasPreview: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z')
  }

  let readContentResult: any
  let readContentCalledWith: any

  async function buildApp() {
    global.WIKI = {
      config: {},
      sites: {
        [siteId]: { id: siteId, isEnabled: true }
      },
      models: {
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => true
        },
        assets: {
          getAsset: async () => asset,
          readContent: async (a: any, sId: string) => {
            readContentCalledWith = { a, sId }
            return readContentResult
          }
        }
      }
    } as unknown as WikiGlobal

    const app = fastify()
    await app.register(fastifySensible)
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/etc. is a thrown
    //    `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that shapes it
    //    into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerSchemas(app)
    await registerErrorSchema(app)
    await app.register(routes)
    await app.ready()
    return app
  }

  test('serves the buffer path with Content-Disposition and X-Content-Type-Options set, and passes siteId through', async () => {
    readContentResult = { body: Buffer.from('the bytes'), size: 9 }
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${siteId}/assets/${assetId}/content`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-disposition'], 'attachment; filename="archive.zip"')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['content-length'], '9')
    assert.equal(res.body, 'the bytes')
    assert.equal(readContentCalledWith.sId, siteId)
    await app.close()
  })

  test('serves the stream path with the exact same headers as the buffer path', async () => {
    readContentResult = { body: Readable.from([Buffer.from('the bytes')]), size: 9 }
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${siteId}/assets/${assetId}/content`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-disposition'], 'attachment; filename="archive.zip"')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['content-length'], '9')
    assert.equal(res.body, 'the bytes')
    await app.close()
  })

  test('issues a 302 to the direct-access URL when readContent supplies one, instead of serving bytes', async () => {
    readContentResult = { redirectUrl: 'https://cdn.example.com/asset-1' }
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${siteId}/assets/${assetId}/content`
    })
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, 'https://cdn.example.com/asset-1')
    await app.close()
  })

  test('answers 404 when readContent finds no content', async () => {
    readContentResult = null
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${siteId}/assets/${assetId}/content`
    })
    assert.equal(res.statusCode, 404)
    await app.close()
  })
})

describe('disabled-site guard (task 699)', () => {
  /**
   * Regression test for task 699: the siteId-scoped asset READ routes (`GET .../assets/:assetId` and
   * `GET .../assets/:assetId/content`) trust a `siteId` the client already has cached, the same
   * concern `pages.test.ts` covers for pages. Only the two GET (read) routes are gated —
   * upload/rename/delete stay reachable so an administrator can keep cleaning up a disabled site's
   * content, per the task.
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
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/etc. is a thrown
    //    `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that shapes it
    //    into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerSchemas(app)
    await registerErrorSchema(app)
    await app.register(routes)
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
   * for assets, not just pages. Exercised directly, plus one route wiring check per call site that
   * can reach `mayOnAsset` without extra session setup (upload requires an authenticated session and
   * is covered indirectly by the direct `mayOnAsset` test instead). Sharing this describe's app/WIKI
   * setup rather than standing up its own, since both cover the same siteId-scoped asset routes.
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
})
