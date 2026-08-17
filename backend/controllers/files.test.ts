import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import fastifySensible from '@fastify/sensible'
import routes from './files.ts'

/**
 * Exercises `/_files/*` at the HTTP layer via `app.inject()`, with every `WIKI.models.*` call it
 * makes stubbed. `readContent()`'s own target-aware branching (disk cache vs. buffered read vs.
 * redirect) is covered at the model level in `models/assets.test.ts`; what this proves is the layer
 * this task actually touched here — that the route sets its response headers exactly the same way
 * whichever kind of result `readContent()` hands back (a stream, a buffer, or a redirect), since those
 * headers are set once, before the `readContent()` call, and must not depend on which path served the
 * bytes.
 */
const asset = {
  id: 'asset-1',
  fileName: 'archive.zip',
  fileExt: 'zip',
  folderPath: 'docs',
  locale: 'en',
  mimeType: 'application/zip',
  updatedAt: new Date('2024-01-01T00:00:00Z')
}

let readContentResult: any

async function buildApp() {
  global.WIKI = {
    config: {},
    models: {
      sites: { getSiteByHostname: async () => ({ id: 'site-1' }) },
      groups: {
        actorForRequest: () => ({ permissions: [] }),
        checkAccess: () => true
      },
      assets: {
        resolveAssetPath: async () => asset,
        forgetPath: () => {},
        readContent: async () => readContentResult
      }
    }
  } as unknown as WikiGlobal

  const app = Fastify()
  await app.register(fastifySensible)
  await app.register(routes)
  await app.ready()
  return app
}

before(async () => {
  // -> app.inject() needs no real socket, but building the app still requires WIKI to exist for the
  //    plugin registration path (fastify-sensible etc. don't touch it, but set a baseline anyway).
  global.WIKI = { config: {} } as unknown as WikiGlobal
})

test('serves the buffer path (streaming off) with ETag, Cache-Control, Content-Disposition set', async () => {
  readContentResult = { body: Buffer.from('the bytes'), size: 9 }
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: '/docs/archive.zip' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers.etag, '"asset-1-1704067200000"')
  assert.equal(res.headers['cache-control'], 'private, max-age=600, must-revalidate')
  assert.equal(res.headers['content-disposition'], 'attachment; filename="archive.zip"')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['content-length'], '9')
  assert.equal(res.body, 'the bytes')
  await app.close()
})

test('serves the stream path (streaming on) with the exact same headers as the buffer path', async () => {
  readContentResult = { body: Readable.from([Buffer.from('the bytes')]), size: 9 }
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: '/docs/archive.zip' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers.etag, '"asset-1-1704067200000"')
  assert.equal(res.headers['cache-control'], 'private, max-age=600, must-revalidate')
  assert.equal(res.headers['content-disposition'], 'attachment; filename="archive.zip"')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['content-length'], '9')
  assert.equal(res.body, 'the bytes')
  await app.close()
})

test('issues a 302 to the direct-access URL when readContent supplies one, instead of serving bytes', async () => {
  readContentResult = { redirectUrl: 'https://cdn.example.com/asset-1' }
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: '/docs/archive.zip' })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, 'https://cdn.example.com/asset-1')
  await app.close()
})

test('answers 404 when readContent finds no content, without a Content-Disposition or redirect', async () => {
  readContentResult = null
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: '/docs/archive.zip' })
  assert.equal(res.statusCode, 404)
  assert.equal(res.headers['content-disposition'], undefined)
  assert.equal(res.headers.location, undefined)
  await app.close()
})
