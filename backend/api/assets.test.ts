import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import fastifySensible from '@fastify/sensible'
import { registerSchemas } from './schemas/asset.ts'
import routes from './assets.ts'

/**
 * Exercises `/sites/:siteId/assets/:assetId/content` at the HTTP layer via `app.inject()`, mirroring
 * `controllers/files.test.ts` for the public route: `readContent()`'s own streaming/directAccess
 * branching is covered at the model level in `models/assets.test.ts`, so this proves only what this
 * task changed at the route layer — that `Content-Disposition` and `X-Content-Type-Options` are set
 * exactly the same way whichever kind of result `readContent()` hands back, and that a `redirectUrl`
 * short-circuits to a 302 before any of them are touched.
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

  const app = Fastify()
  await app.register(fastifySensible)
  await registerSchemas(app)
  await app.register(routes)
  await app.ready()
  return app
}

test('serves the buffer path with Content-Disposition and X-Content-Type-Options set, and passes siteId through', async () => {
  readContentResult = { body: Buffer.from('the bytes'), size: 9 }
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/sites/${siteId}/assets/${assetId}/content` })
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
  const res = await app.inject({ method: 'GET', url: `/sites/${siteId}/assets/${assetId}/content` })
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
  const res = await app.inject({ method: 'GET', url: `/sites/${siteId}/assets/${assetId}/content` })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, 'https://cdn.example.com/asset-1')
  await app.close()
})

test('answers 404 when readContent finds no content', async () => {
  readContentResult = null
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/sites/${siteId}/assets/${assetId}/content` })
  assert.equal(res.statusCode, 404)
  await app.close()
})
