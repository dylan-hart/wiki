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
  let resolvedAsset: any

  /**
   * `security.forceAssetDownload: true` matches `base.yml`'s real default -- every actual instance
   * merges that in, so a test that wants to exercise realistic behavior needs it here too, since this
   * stub bypasses the base.yml merge entirely (task/OpenProject #859: the route used to force download
   * on EVERY asset whenever this was on, images included, contradicting its own admin-facing
   * description ("non-image files"); the fix scopes it to non-`INLINE_EXTS` extensions only).
   */
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
    // -> app.inject() needs no real socket, but building the app still requires WIKI to exist for the
    //    plugin registration path (fastify-sensible etc. don't touch it, but set a baseline anyway).
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
   * OpenProject #1360/#2152/#2157 (2026-08-24 security audit §1, §3): an `.svg` asset can never take
   * the attachment branch (it is always in `INLINE_EXTS`), so the durable fix is this response
   * carrying the same sandboxing `SVG_CSP` the admin-uploaded site logo/favicon path
   * (`controllers/site.ts`) already sends — sourced from one shared constant (`helpers/security.ts`)
   * so the two cannot drift, and regardless of `forceAssetDownload`, since an attachment hint is not
   * honoured on every direct navigation.
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

  /**
   * Regression test for task 676: the `checkAccess` call here resolves its site from
   * `getSiteByHostname` rather than from a route param — a different source than every other call
   * site in this task, but the same fix — so a page rule scoped to one site (task 671) is enforced
   * when a file is served through `/_files/*` too. Sharing this describe's app/WIKI setup rather than
   * standing up its own, since both cover the same hostname-resolved file routes.
   */
  test('passes the hostname-resolved siteId through to checkAccess', async () => {
    const originalResolveAssetPath = (globalThis as any).WIKI.models.assetServing.resolveAssetPath
    const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
    const calls: any[] = []
    ;(globalThis as any).WIKI.models.assetServing.resolveAssetPath = async () => ({
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
      ;(globalThis as any).WIKI.models.assetServing.resolveAssetPath = originalResolveAssetPath
      ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
    }
  })
})

describe('enforceApiKeySite (OpenProject #2201)', () => {
  /**
   * `/_files/*` resolves its site from `req.hostname`, not a `:siteId` route param, so a params-only
   * site-pin hook can never see this route -- it has to call `enforceApiKeySite()` for itself, right
   * after resolving the site. This is the WP's own worked example: a key pinned to site A must be
   * refused when the URL's hostname serves site B, before the asset path is ever resolved.
   */

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
