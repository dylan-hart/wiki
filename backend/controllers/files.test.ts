import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { Readable } from 'node:stream'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import filesRoutes from './files.ts'
import { SVG_CSP } from '../helpers/security.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

describe('response headers (byte-serving behavior)', () => {
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
  let resolvedAsset: any

  /** `forceAssetDownload: true` is `base.yml`'s default, which this stub does not merge in. */
  async function buildApp(security: Record<string, unknown> = { forceAssetDownload: true }) {
    wikiHandle = installTestWiki({
      config: { security },
      models: {
        sites: { getSiteByHostname: async () => ({ id: 'site-1' }) },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => true
        },
        assetServing: {
          resolveAssetPath: async () => resolvedAsset ?? asset,
          forgetPath: () => {},
          readContent: async () => readContentResult
        }
      }
    })

    const app = fastify()
    await app.register(fastifySensible)
    await app.register(filesRoutes)
    await app.ready()
    return app
  }

  before(async () => {
    wikiHandle = installTestWiki({ config: {} })
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

  test('never forces an image (INLINE_EXTS) extension to download, even with forceAssetDownload on (OpenProject #859)', async () => {
    resolvedAsset = { ...asset, fileName: 'photo.png', fileExt: 'png', mimeType: 'image/png' }
    readContentResult = { body: Buffer.from('the bytes'), size: 9 }
    const app = await buildApp({ forceAssetDownload: true })
    const res = await app.inject({ method: 'GET', url: '/docs/photo.png' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-disposition'], undefined)
    resolvedAsset = undefined
    await app.close()
  })

  test('does not force a non-image extension to download when forceAssetDownload is off (dispositionFor, OpenProject #2164)', async () => {
    readContentResult = { body: Buffer.from('the bytes'), size: 9 }
    const app = await buildApp({ forceAssetDownload: false })
    const res = await app.inject({ method: 'GET', url: '/docs/archive.zip' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-disposition'], undefined)
    await app.close()
  })

  /**
   * An `.svg` is always in `INLINE_EXTS`, so it never takes the attachment branch: the sandboxing CSP
   * is its only protection, whatever `forceAssetDownload` says.
   */
  test('attaches SVG_CSP for an image/svg+xml asset, with and without forceAssetDownload (OpenProject #2157)', async () => {
    resolvedAsset = { ...asset, fileName: 'diagram.svg', fileExt: 'svg', mimeType: 'image/svg+xml' }
    readContentResult = { body: Buffer.from('<svg><script>alert(1)</script></svg>'), size: 37 }
    for (const forceAssetDownload of [true, false]) {
      const app = await buildApp({ forceAssetDownload })
      const res = await app.inject({ method: 'GET', url: '/docs/diagram.svg' })
      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['content-security-policy'], SVG_CSP)
      await app.close()
    }
    resolvedAsset = undefined
  })

  test('attaches SVG_CSP for an HTML-typed asset too, closing the forceAssetDownload:false gap (§3)', async () => {
    resolvedAsset = { ...asset, fileName: 'page.html', fileExt: 'html', mimeType: 'text/html' }
    readContentResult = { body: Buffer.from('<script>alert(1)</script>'), size: 26 }
    const app = await buildApp({ forceAssetDownload: false })
    const res = await app.inject({ method: 'GET', url: '/docs/page.html' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-security-policy'], SVG_CSP)
    resolvedAsset = undefined
    await app.close()
  })

  test('sets no Content-Security-Policy for an ordinary, non-active-document asset', async () => {
    readContentResult = { body: Buffer.from('the bytes'), size: 9 }
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/docs/archive.zip' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-security-policy'], undefined)
    await app.close()
  })
})

describe('isEnabled guard (task 699)', () => {
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
    wikiHandle = installTestWiki({
      config: { security: {} },
      models: {
        sites: { getSiteByHostname },
        assetServing: {
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
    })
    app = fastify()
    await app.register(fastifySensible)
    await app.register(filesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
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

  /** Without the site id, a page rule scoped to one site would not be enforced on `/_files/*`. */
  test('passes the hostname-resolved siteId through to checkAccess', async () => {
    const originalResolveAssetPath = (globalThis as any).CARDINAL.models.assetServing
      .resolveAssetPath
    const originalCheckAccess = (globalThis as any).CARDINAL.models.groups.checkAccess
    const calls: any[] = []
    ;(globalThis as any).CARDINAL.models.assetServing.resolveAssetPath = async () => ({
      id: 'asset-1',
      folderPath: '',
      fileName: 'file.png',
      locale: 'en',
      updatedAt: new Date()
    })
    ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
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
      ;(globalThis as any).CARDINAL.models.assetServing.resolveAssetPath = originalResolveAssetPath
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = originalCheckAccess
    }
  })
})

describe('enforceApiKeySite (OpenProject #2201)', () => {
  const SITE_A = { id: 'site-a', hostname: 'sitea.example.com' }
  const SITE_B = { id: 'site-b', hostname: 'siteb.example.com' }

  let resolveAssetPathCalls = 0
  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      config: { security: {} },
      models: {
        sites: {
          getSiteByHostname: async ({ hostname }: { hostname: string }) =>
            [SITE_A, SITE_B].find((s) => s.hostname === hostname) ?? null
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => true
        },
        assetServing: {
          resolveAssetPath: async () => {
            resolveAssetPathCalls++
            return null
          },
          forgetPath: () => {}
        }
      }
    })
    app = fastify()
    await app.register(fastifySensible)
    await app.register(filesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  test('refuses 403 when the key is pinned to a different site than the one the hostname resolves to', async () => {
    resolveAssetPathCalls = 0
    const app2 = fastify()
    await app2.register(fastifySensible)
    app2.addHook('onRequest', (req, _reply, done) => {
      ;(req as any).apiKey = { id: 'key-1', permissions: [], siteId: SITE_A.id }
      done()
    })
    await app2.register(filesRoutes)
    await app2.ready()
    try {
      const res = await app2.inject({
        method: 'GET',
        url: '/some/file.png',
        headers: { host: SITE_B.hostname }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(resolveAssetPathCalls, 0)
    } finally {
      await app2.close()
    }
  })

  test('lets the request through when the pinned key matches the hostname-resolved site', async () => {
    resolveAssetPathCalls = 0
    const app2 = fastify()
    await app2.register(fastifySensible)
    app2.addHook('onRequest', (req, _reply, done) => {
      ;(req as any).apiKey = { id: 'key-1', permissions: [], siteId: SITE_A.id }
      done()
    })
    await app2.register(filesRoutes)
    await app2.ready()
    try {
      const res = await app2.inject({
        method: 'GET',
        url: '/some/file.png',
        headers: { host: SITE_A.hostname }
      })
      // -> Not found because resolveAssetPath is stubbed to return null, but the pin check let it get
      //    there
      assert.equal(res.statusCode, 404)
      assert.equal(resolveAssetPathCalls, 1)
    } finally {
      await app2.close()
    }
  })

  test('an unpinned key (siteId: null) is unaffected, same as no key at all', async () => {
    resolveAssetPathCalls = 0
    const res = await app.inject({
      method: 'GET',
      url: '/some/file.png',
      headers: { host: SITE_B.hostname }
    })
    assert.equal(res.statusCode, 404)
    assert.equal(resolveAssetPathCalls, 1)
  })
})
