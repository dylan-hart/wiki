import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { Readable } from 'node:stream'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import filesRoutes from './files.ts'

describe('response headers (byte-serving behavior)', () => {
  /**
   * Exercises `/_files/*` at the HTTP layer via `app.inject()`, with every `WIKI.models.*` call it
   * makes stubbed. `readContent()`'s own target-aware branching (disk cache vs. buffered read vs.
   * redirect) is covered at the model level in `models/assets.test.ts`; what this proves is the layer
   * this task actually touched here — that the route sets its response headers exactly the same way
   * whichever kind of result `readContent()` hands back (a stream, a buffer, or a redirect), since
   * those headers are set once, before the `readContent()` call, and must not depend on which path
   * served the bytes.
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

    const app = fastify()
    await app.register(fastifySensible)
    await app.register(filesRoutes)
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
})

describe('isEnabled guard (task 699)', () => {
  /**
   * Regression test for task 699: `/_files/*` serves uploaded file bytes resolved by hostname
   * independently of the page/shell hook in `index.ts`, so a disabled site's files stayed reachable by
   * direct URL forever. Asserts the same contract as `api/bootstrap.test.ts` — a disabled site answers
   * 403, distinguishable from the pre-existing 404 for a hostname that matches no site.
   */

  const ENABLED_SITE_ID = 'enabled-site-id'
  const DISABLED_SITE_ID = 'disabled-site-id'

  const sites: Record<string, any> = {
    [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, hostname: 'wiki.example.com', isEnabled: true },
    [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, hostname: 'off.example.com', isEnabled: false }
  }

  async function getSiteByHostname({ hostname }: { hostname: string }) {
    return Object.values(sites).find((s) => s.hostname === hostname) ?? null
  }

  let resolveAssetPathCalls = 0

  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
      config: { security: {} },
      models: {
        sites: { getSiteByHostname },
        assets: {
          resolveAssetPath: async () => {
            resolveAssetPathCalls++
            return null
          }
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => false
        }
      }
    }
    app = fastify()
    await app.register(fastifySensible)
    await app.register(filesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('answers 404 for a hostname with no site behind it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/some/file.png',
      headers: { host: 'nowhere.example.com' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('answers 403, distinguishable from 404, for a resolved-but-disabled site, before ever resolving the path', async () => {
    resolveAssetPathCalls = 0
    const res = await app.inject({
      method: 'GET',
      url: '/some/file.png',
      headers: { host: 'off.example.com' }
    })
    assert.equal(res.statusCode, 403)
    assert.notEqual(res.statusCode, 404)
    assert.match(res.json().message, /disabled/i)
    assert.equal(resolveAssetPathCalls, 0)
  })

  test('an enabled site passes the guard through to the normal asset-path resolution', async () => {
    resolveAssetPathCalls = 0
    const res = await app.inject({
      method: 'GET',
      url: '/some/file.png',
      headers: { host: 'wiki.example.com' }
    })
    // -> Not found because resolveAssetPath is stubbed to return null, but the guard let it get there
    assert.equal(res.statusCode, 404)
    assert.equal(resolveAssetPathCalls, 1)
  })

  /**
   * Regression test for task 676: the `checkAccess` call here resolves its site from
   * `getSiteByHostname` rather than from a route param — a different source than every other call
   * site in this task, but the same fix — so a page rule scoped to one site (task 671) is enforced
   * when a file is served through `/_files/*` too. Sharing this describe's app/WIKI setup rather than
   * standing up its own, since both cover the same hostname-resolved file routes.
   */
  test('passes the hostname-resolved siteId through to checkAccess', async () => {
    const originalResolveAssetPath = (globalThis as any).WIKI.models.assets.resolveAssetPath
    const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
    const calls: any[] = []
    ;(globalThis as any).WIKI.models.assets.resolveAssetPath = async () => ({
      id: 'asset-1',
      folderPath: '',
      fileName: 'file.png',
      locale: 'en',
      updatedAt: new Date()
    })
    ;(globalThis as any).WIKI.models.groups.checkAccess = (
      _actor: any,
      _permission: string,
      page: any
    ) => {
      calls.push(page)
      return false
    }
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/file.png',
        headers: { host: 'wiki.example.com' }
      })
      assert.equal(res.statusCode, 404)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].siteId, ENABLED_SITE_ID)
    } finally {
      ;(globalThis as any).WIKI.models.assets.resolveAssetPath = originalResolveAssetPath
      ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
    }
  })
})
