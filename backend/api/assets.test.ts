import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import routes from './assets.ts'
import { mayOnAsset } from '../helpers/pageAccess.ts'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import { SVG_CSP } from '../helpers/security.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

describe('download route: byte-serving behavior', () => {
  /**
   * Exercises `/sites/:siteId/assets/:assetId/content` at the HTTP layer via `app.inject()`,
   * mirroring `controllers/files.test.ts` for the public route: `readContent()`'s own
   * streaming/directAccess branching is covered at the model level in `models/assets.test.ts`, so
   * this proves only what this task changed at the route layer — that `Content-Disposition`,
   * `X-Content-Type-Options` and (for an SVG- or HTML-typed asset) `Content-Security-Policy` are set
   * exactly the same way whichever kind of result `readContent()` hands back, that the unified
   * `dispositionFor()` predicate (OpenProject #2164) agrees with `/_files/`'s, and that a
   * `redirectUrl` short-circuits to a 302 before any of them are touched.
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
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    locale: 'en'
  }

  let readContentResult: any
  let readContentCalledWith: any
  let resolvedAsset: any

  /**
   * `security.forceAssetDownload: true` matches `base.yml`'s real default, same as
   * `controllers/files.test.ts`'s own `buildApp` -- a test that wants realistic behavior needs it
   * here too, since this stub bypasses the base.yml merge entirely.
   */
  async function buildApp(security: Record<string, unknown> = { forceAssetDownload: true }) {
    return buildTestApp({
      routes,
      wiki: {
        config: { security },
        sites: {
          [siteId]: { id: siteId, isEnabled: true }
        },
        models: {
          groups: {
            actorForRequest: () => ({ permissions: [] }),
            checkAccess: () => true
          },
          assets: {
            getAsset: async () => resolvedAsset ?? asset
          },
          // -> `readContent` moved to `models/assetServing.ts` when the serving cache was split out
          //    of `models/assets.ts`; the `/content` route reaches it there now.
          assetServing: {
            readContent: async (a: any, sId: string) => {
              readContentCalledWith = { a, sId }
              return readContentResult
            }
          }
        }
      }
    })
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
    await closeTestApp(app)
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
    await closeTestApp(app)
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
    await closeTestApp(app)
  })

  test('answers 404 when readContent finds no content', async () => {
    readContentResult = null
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${siteId}/assets/${assetId}/content`
    })
    assert.equal(res.statusCode, 404)
    await closeTestApp(app)
  })

  /**
   * OpenProject #1360/#2152/#2164 (2026-08-24 security audit §3): this route's `Content-Disposition`
   * predicate used to be inverted relative to `/_files/*`'s — `forceAssetDownload ||
   * !INLINE_EXTS.has(ext)` forced every image to download whenever `forceAssetDownload` was on (the
   * shipped default), and forced every non-image extension to download regardless of the setting.
   * Both routes now call the one shared `models/assets.ts#dispositionFor` predicate.
   */
  test('never forces an inline (INLINE_EXTS) extension to download, even with forceAssetDownload on (dispositionFor, OpenProject #2164)', async () => {
    resolvedAsset = { ...asset, fileName: 'photo.png', fileExt: 'png', mimeType: 'image/png' }
    readContentResult = { body: Buffer.from('the bytes'), size: 9 }
    const app = await buildApp({ forceAssetDownload: true })
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${siteId}/assets/${assetId}/content`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-disposition'], undefined)
    resolvedAsset = undefined
    await closeTestApp(app)
  })

  test('does not force a non-inline extension to download when forceAssetDownload is off, matching /_files/ (dispositionFor, OpenProject #2164)', async () => {
    readContentResult = { body: Buffer.from('the bytes'), size: 9 }
    const app = await buildApp({ forceAssetDownload: false })
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${siteId}/assets/${assetId}/content`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-disposition'], undefined)
    await closeTestApp(app)
  })

  test('attaches SVG_CSP for an image/svg+xml asset, with and without forceAssetDownload (OpenProject #2157)', async () => {
    resolvedAsset = { ...asset, fileName: 'diagram.svg', fileExt: 'svg', mimeType: 'image/svg+xml' }
    readContentResult = { body: Buffer.from('<svg><script>alert(1)</script></svg>'), size: 37 }
    for (const forceAssetDownload of [true, false]) {
      const app = await buildApp({ forceAssetDownload })
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${siteId}/assets/${assetId}/content`
      })
      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['content-security-policy'], SVG_CSP)
      await app.close()
    }
    resolvedAsset = undefined
  })

  test('attaches SVG_CSP when the served asset is HTML-typed (OpenProject #2157)', async () => {
    resolvedAsset = { ...asset, fileName: 'snippet.html', fileExt: 'html', mimeType: 'text/html' }
    readContentResult = { body: Buffer.from('<script>evil()</script>'), size: 24 }
    const app = await buildApp({ forceAssetDownload: false })
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${siteId}/assets/${assetId}/content`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-security-policy'], SVG_CSP)
    resolvedAsset = undefined
    await closeTestApp(app)
  })

  test('sets no Content-Security-Policy for an ordinary, non-active-document asset', async () => {
    readContentResult = { body: Buffer.from('the bytes'), size: 9 }
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${siteId}/assets/${assetId}/content`
    })
    assert.equal(res.headers['content-security-policy'], undefined)
    await closeTestApp(app)
  })
})

describe('disabled-site guard (task 699 / OpenProject #1587 / #1593)', () => {
  /**
   * Regression test for task 699, widened by OpenProject #1587/#1593: originally only the two
   * siteId-scoped asset READ routes (`GET .../assets/:assetId` and `GET .../assets/:assetId/content`)
   * were gated, via a `guardSiteEnabled()` call hand-applied in each — upload/rename/delete were
   * DELIBERATELY left reachable so an administrator could keep cleaning up a disabled site's content.
   * The 2026-08-24 audit found that gap worth closing instead: `api/assets.ts:68/328/400` (upload,
   * rename, delete) are named in OpenProject #1587 as part of the surface its shared preHandler
   * (`siteEnabledPreHandler`, `helpers/common.ts`) now covers, same as every other `:siteId` route.
   * `assets.ts` itself no longer calls `guardSiteEnabled` anywhere, so this suite wires the same
   * preHandler onto its own standalone app below (mirroring how `api/index.ts` wires it in
   * production).
   */
  const ENABLED_SITE_ID = '11111111-1111-4111-8111-111111111111'
  const DISABLED_SITE_ID = '22222222-2222-4222-8222-222222222222'
  const ASSET_ID = '33333333-3333-4333-8333-333333333333'

  const sites: Record<string, any> = {
    [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, isEnabled: true },
    [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, isEnabled: false }
  }

  let getAssetCalls = 0
  let uploadCalls = 0
  let renameAssetCalls = 0
  let deleteAssetCalls = 0

  let app: FastifyInstance

  before(async () => {
    // -> Mirrors `api/index.ts`'s own registration order: the guard is a plugin-level hook, added
    //    before the route file it covers is registered — `assets.ts` no longer calls
    //    `guardSiteEnabled` itself (OpenProject #1593).
    const guardedRoutes: FastifyPluginAsync = async (instance) => {
      instance.addHook('preHandler', siteEnabledPreHandler)
      await instance.register(routes)
    }

    app = await buildTestApp({
      routes: guardedRoutes,
      ajv: true,
      wiki: {
        sites,
        config: { security: {} },
        models: {
          assets: {
            getAsset: async () => {
              getAssetCalls++
              return null
            },
            upload: async () => {
              uploadCalls++
              return {}
            },
            renameAsset: async () => {
              renameAssetCalls++
              return {}
            },
            deleteAsset: async () => {
              deleteAssetCalls++
              return true
            }
          },
          groups: {
            actorForRequest: () => ({ permissions: [] }),
            checkAccess: () => true
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

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

  /*
    UPLOAD/RENAME/DELETE carried no guard at all before OpenProject #1587/#1593 -- a disabled site's
    file manager stayed fully writable to anyone still holding its siteId. All three now answer 403
    through the shared preHandler wired above, before the handler ever touches `WIKI.models.assets`.
  */

  test('UPLOAD asset: answers 403 for a disabled site, without ever calling upload', async () => {
    uploadCalls = 0
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${DISABLED_SITE_ID}/assets?fileName=photo.png`,
      payload: Buffer.from('bytes'),
      headers: { 'content-type': 'application/octet-stream' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(uploadCalls, 0)
  })

  test('RENAME asset: answers 403 for a disabled site, without ever calling getAsset/renameAsset', async () => {
    getAssetCalls = 0
    renameAssetCalls = 0
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${DISABLED_SITE_ID}/assets/${ASSET_ID}`,
      payload: { fileName: 'renamed.png' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(getAssetCalls, 0)
    assert.equal(renameAssetCalls, 0)
  })

  test('DELETE asset: answers 403 for a disabled site, without ever calling getAsset/deleteAsset', async () => {
    getAssetCalls = 0
    deleteAssetCalls = 0
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${DISABLED_SITE_ID}/assets/${ASSET_ID}`
    })
    assert.equal(res.statusCode, 403)
    assert.equal(getAssetCalls, 0)
    assert.equal(deleteAssetCalls, 0)
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
        fileName: 'bar.png',
        locale: 'en'
      })
      assert.equal(result, true)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].siteId, ENABLED_SITE_ID)
      assert.equal(calls[0].path, 'foo/bar.png')
      assert.equal(calls[0].locale, 'en')
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
      fileName: 'bar.png',
      locale: 'en'
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
      fileName: 'bar.png',
      locale: 'en'
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

/**
 * UPLOAD ASSET: `parentPath` resolution (OpenProject #879)
 *
 * A pending-asset upload now names its destination folder by the page's own parent path rather than
 * an already-known folder ID. Exercised at the HTTP layer via `app.inject()`, standing in for
 * `@fastify/session` the same way `pages.test.ts` does — a preHandler reads an authenticated session
 * off the `x-test-session` header, since the upload route requires one.
 */
describe('upload route: parentPath resolution (OpenProject #879)', () => {
  const SITE_ID = '44444444-4444-4444-8444-444444444444'
  const RESOLVED_FOLDER_ID = '55555555-5555-4555-8555-555555555555'

  const uploadedAsset = {
    id: '66666666-6666-4666-8666-666666666666',
    fileName: 'photo.png',
    fileExt: 'png',
    kind: 'image',
    mimeType: 'image/png',
    fileSize: 3,
    folderPath: 'guides.setup',
    title: 'photo',
    hasPreview: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    locale: 'en'
  }

  let getFolderCalls: any[]
  let getFolderByIdCalls: any[]
  let checkAccessCalls: any[]
  let uploadCalls: any[]
  let checkAccessResult: boolean

  let app: FastifyInstance

  before(async () => {
    getFolderCalls = []
    getFolderByIdCalls = []
    checkAccessCalls = []
    uploadCalls = []
    checkAccessResult = true

    app = await buildTestApp({
      routes,
      session: 'header',
      wiki: {
        sites: {
          [SITE_ID]: { id: SITE_ID, isEnabled: true, config: { locales: { primary: 'en' } } }
        },
        config: { security: {} },
        models: {
          groups: {
            actorForRequest: () => ({ permissions: [] }),
            checkAccess: (_actor: any, _permission: string, page: any) => {
              checkAccessCalls.push(page)
              return checkAccessResult
            }
          },
          tree: {
            // -> Echoes back a resolved-in-this-site folder for the given id (OpenProject #2127:
            //    getFolderById is now siteId-scoped, and the upload route trusts its resolved `.id`
            //    rather than the raw query param) -- a foreign/unknown id is exercised in its own
            //    dedicated test below with a `null`-returning override.
            getFolderById: async (id: string, _siteId: string) => {
              getFolderByIdCalls.push(id)
              return { id, folderPath: '', fileName: '' }
            },
            getFolder: async (opts: any) => {
              getFolderCalls.push(opts)
              return {
                id: RESOLVED_FOLDER_ID,
                folderPath: 'guides',
                fileName: 'setup',
                locale: 'en'
              }
            }
          },
          assets: {
            upload: async (opts: any) => {
              uploadCalls.push(opts)
              return uploadedAsset
            }
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  function sessionHeader() {
    return {
      'x-test-session': JSON.stringify({
        authenticated: true,
        user: { id: 'user-1' },
        permissions: []
      })
    }
  }

  test('resolves-or-creates the folder from `parentPath` and uploads into it, in one request', async () => {
    getFolderCalls = []
    uploadCalls = []
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/assets?fileName=photo.png&parentPath=guides%2Fsetup`,
      headers: { ...sessionHeader(), 'content-type': 'image/png' },
      payload: Buffer.from([1, 2, 3])
    })
    assert.equal(res.statusCode, 200)
    assert.equal(getFolderCalls.length, 1)
    assert.equal(getFolderCalls[0].path, 'guides/setup')
    assert.equal(getFolderCalls[0].siteId, SITE_ID)
    assert.equal(getFolderCalls[0].createIfMissing, true)
    assert.equal(uploadCalls.length, 1)
    assert.equal(uploadCalls[0].folderId, RESOLVED_FOLDER_ID)
  })

  test('normalizes `parentPath` before both the permission check and the resolve-or-create call, so they can never diverge', async () => {
    getFolderCalls = []
    uploadCalls = []
    checkAccessCalls = []
    const res = await app.inject({
      method: 'POST',
      // -> Mixed case and a wrapping slash: `getFolder`/`createFolder` would resolve and create
      //    this at the same normalized path as `guides/setup` regardless, so the permission check
      //    must be run against that same normalized string, not the raw one, or a page rule written
      //    (as every page path is) in normalized form could be evaded just by changing the casing.
      url: `/sites/${SITE_ID}/assets?fileName=photo.png&parentPath=%2FGuides%2FSetup%2F`,
      headers: { ...sessionHeader(), 'content-type': 'image/png' },
      payload: Buffer.from([1, 2, 3])
    })
    assert.equal(res.statusCode, 200)
    assert.equal(checkAccessCalls.length, 1)
    assert.equal(checkAccessCalls[0].path, 'guides/setup/photo.png')
    assert.equal(getFolderCalls.length, 1)
    assert.equal(getFolderCalls[0].path, 'guides/setup')
  })

  test('an empty `parentPath` (root-level page) uploads to the asset root, unchanged', async () => {
    getFolderCalls = []
    uploadCalls = []
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/assets?fileName=photo.png&parentPath=`,
      headers: { ...sessionHeader(), 'content-type': 'image/png' },
      payload: Buffer.from([1, 2, 3])
    })
    assert.equal(res.statusCode, 200)
    assert.equal(getFolderCalls.length, 0)
    assert.equal(uploadCalls.length, 1)
    assert.equal(uploadCalls[0].folderId, undefined)
  })

  test('`folderId` wins over `parentPath` when both are sent, and never resolves by path', async () => {
    getFolderCalls = []
    getFolderByIdCalls = []
    uploadCalls = []
    const explicitFolderId = '77777777-7777-4777-8777-777777777777'
    const originalGetFolderById = (globalThis as any).WIKI.models.tree.getFolderById
    ;(globalThis as any).WIKI.models.tree.getFolderById = async (id: string) => {
      getFolderByIdCalls.push(id)
      return { id, siteId: SITE_ID, fileName: 'sub', folderPath: '', locale: 'en' }
    }
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/assets?fileName=photo.png&folderId=${explicitFolderId}&parentPath=guides%2Fsetup`,
        headers: { ...sessionHeader(), 'content-type': 'image/png' },
        payload: Buffer.from([1, 2, 3])
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(getFolderByIdCalls, [explicitFolderId])
      assert.equal(getFolderCalls.length, 0)
      assert.equal(uploadCalls[0].folderId, explicitFolderId)
    } finally {
      ;(globalThis as any).WIKI.models.tree.getFolderById = originalGetFolderById
    }
  })

  /**
   * OpenProject #1666: the upload route looked `folderId` up by bare id with no site check, unlike
   * CREATE/RENAME/DELETE FOLDER in `tree.ts` -- a `folderId` from another site let the permission
   * check evaluate against the wrong (site-root) destination instead of refusing the request. Also
   * covers the missing/nonexistent-id case, which fell through the same way.
   */
  test('rejects a `folderId` belonging to another site (404, no upload, permission check never runs against the wrong destination)', async () => {
    getFolderByIdCalls = []
    checkAccessCalls = []
    uploadCalls = []
    const FOREIGN_SITE_ID = '99999999-9999-4999-8999-999999999999'
    const foreignFolderId = '88888888-8888-4888-8888-888888888888'
    const originalGetFolderById = (globalThis as any).WIKI.models.tree.getFolderById
    ;(globalThis as any).WIKI.models.tree.getFolderById = async (id: string) => {
      getFolderByIdCalls.push(id)
      return { id, siteId: FOREIGN_SITE_ID, fileName: 'sub', folderPath: '', locale: 'en' }
    }
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/assets?fileName=photo.png&folderId=${foreignFolderId}`,
        headers: { ...sessionHeader(), 'content-type': 'image/png' },
        payload: Buffer.from([1, 2, 3])
      })
      assert.equal(res.statusCode, 404)
      assert.deepEqual(getFolderByIdCalls, [foreignFolderId])
      assert.equal(checkAccessCalls.length, 0, 'must be refused before the permission check runs')
      assert.equal(uploadCalls.length, 0)
    } finally {
      ;(globalThis as any).WIKI.models.tree.getFolderById = originalGetFolderById
    }
  })

  test('rejects a nonexistent `folderId` (404, no upload)', async () => {
    getFolderByIdCalls = []
    checkAccessCalls = []
    uploadCalls = []
    const missingFolderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    // -> Default mock from `before()` returns null for any id, standing in for "no such row"
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/assets?fileName=photo.png&folderId=${missingFolderId}`,
      headers: { ...sessionHeader(), 'content-type': 'image/png' },
      payload: Buffer.from([1, 2, 3])
    })
    assert.equal(res.statusCode, 404)
    assert.deepEqual(getFolderByIdCalls, [missingFolderId])
    assert.equal(checkAccessCalls.length, 0)
    assert.equal(uploadCalls.length, 0)
  })

  /**
   * OpenProject #2127/#2131: `getFolderById()` is now scoped to the request's own site, so a
   * `folderId` that resolves to nothing there (unknown, or belonging to another site) must not
   * reach `upload()` as a parent -- previously the raw, unverified query param was passed straight
   * through regardless of whether it resolved to anything at all.
   */
  test('a folderId that does not resolve in this site is never passed through to upload()', async () => {
    getFolderCalls = []
    getFolderByIdCalls = []
    uploadCalls = []
    checkAccessCalls = []
    const foreignFolderId = '99999999-9999-4999-8999-999999999999'
    const originalGetFolderById = (globalThis as any).WIKI.models.tree.getFolderById
    ;(globalThis as any).WIKI.models.tree.getFolderById = async (id: string) => {
      getFolderByIdCalls.push(id)
      return null
    }
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/assets?fileName=photo.png&folderId=${foreignFolderId}`,
        headers: { ...sessionHeader(), 'content-type': 'image/png' },
        payload: Buffer.from([1, 2, 3])
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(getFolderByIdCalls, [foreignFolderId])
      // -> Checked against the root, not the foreign folder's (nonexistent, from this site's view)
      //    path -- the whole point of scoping the lookup
      assert.equal(checkAccessCalls[0].path, 'photo.png')
      assert.equal(uploadCalls[0].folderId, undefined)
    } finally {
      ;(globalThis as any).WIKI.models.tree.getFolderById = originalGetFolderById
    }
  })

  test('a denied permission never resolves-or-creates the folder: no side effect from an unauthorized upload', async () => {
    getFolderCalls = []
    uploadCalls = []
    checkAccessCalls = []
    checkAccessResult = false
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/assets?fileName=photo.png&parentPath=guides%2Fsetup`,
        headers: { ...sessionHeader(), 'content-type': 'image/png' },
        payload: Buffer.from([1, 2, 3])
      })
      assert.equal(res.statusCode, 403)
      assert.equal(checkAccessCalls.length, 1)
      assert.equal(checkAccessCalls[0].path, 'guides/setup/photo.png')
      assert.equal(getFolderCalls.length, 0)
      assert.equal(uploadCalls.length, 0)
    } finally {
      checkAccessResult = true
    }
  })
})
