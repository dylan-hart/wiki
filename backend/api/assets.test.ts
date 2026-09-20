import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import routes from './assets.ts'
import { mayOnAsset } from '../helpers/pageAccess.ts'
import { activeBanMemo } from '../helpers/rateLimit.ts'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import { SVG_CSP } from '../helpers/security.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

describe('download route: byte-serving behavior', () => {
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

  /** `forceAssetDownload: true` is `base.yml`'s default, which this stub's config never merges. */
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
  let moveAssetCalls = 0
  let deleteAssetCalls = 0

  let app: FastifyInstance

  before(async () => {
    // -> As `api/index.ts` wires it: the guard is a plugin-level hook added before the route file
    //    is registered, not something `assets.ts` calls itself.
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
            moveAsset: async () => {
              moveAssetCalls++
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

  test('MOVE asset: answers 403 for a disabled site, without ever calling getAsset/moveAsset', async () => {
    getAssetCalls = 0
    moveAssetCalls = 0
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${DISABLED_SITE_ID}/assets/${ASSET_ID}/folder`,
      payload: {}
    })
    assert.equal(res.statusCode, 403)
    assert.equal(getAssetCalls, 0)
    assert.equal(moveAssetCalls, 0)
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
   * `mayOnAsset` site scoping: a page rule scoped to one site has to hold for assets too. These
   * share this describe's app and `CARDINAL` setup rather than standing up their own.
   */

  test('mayOnAsset: threads siteId into the RulePageRef passed to checkAccess', () => {
    const calls: any[] = []
    const originalCheckAccess = (globalThis as any).CARDINAL.models.groups.checkAccess
    ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
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
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = originalCheckAccess
    }
  })

  test('GET asset metadata route: passes the route siteId through to checkAccess', async () => {
    const calls: any[] = []
    const originalGetAsset = (globalThis as any).CARDINAL.models.assets.getAsset
    const originalCheckAccess = (globalThis as any).CARDINAL.models.groups.checkAccess
    ;(globalThis as any).CARDINAL.models.assets.getAsset = async () => ({
      folderPath: 'foo',
      fileName: 'bar.png',
      locale: 'en'
    })
    ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
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
      ;(globalThis as any).CARDINAL.models.assets.getAsset = originalGetAsset
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = originalCheckAccess
    }
  })

  test('DELETE asset route: passes the route siteId through to checkAccess', async () => {
    const calls: any[] = []
    const originalGetAsset = (globalThis as any).CARDINAL.models.assets.getAsset
    const originalCheckAccess = (globalThis as any).CARDINAL.models.groups.checkAccess
    const originalDeleteAsset = (globalThis as any).CARDINAL.models.assets.deleteAsset
    ;(globalThis as any).CARDINAL.models.assets.getAsset = async () => ({
      folderPath: 'foo',
      fileName: 'bar.png',
      locale: 'en'
    })
    ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
      _actor: any,
      _permission: string,
      page: any
    ) => {
      calls.push(page)
      return false
    }
    ;(globalThis as any).CARDINAL.models.assets.deleteAsset = async () => true
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/sites/${ENABLED_SITE_ID}/assets/${ASSET_ID}`
      })
      assert.equal(res.statusCode, 403)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].siteId, ENABLED_SITE_ID)
    } finally {
      ;(globalThis as any).CARDINAL.models.assets.getAsset = originalGetAsset
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = originalCheckAccess
      ;(globalThis as any).CARDINAL.models.assets.deleteAsset = originalDeleteAsset
    }
  })
})

describe('MOVE ASSET route (OpenProject #2447)', () => {
  const SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const ASSET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const DESTINATION_FOLDER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  const existingAsset = {
    id: ASSET_ID,
    fileName: 'photo.png',
    fileExt: 'png',
    kind: 'image',
    mimeType: 'image/png',
    fileSize: 3,
    folderPath: 'source',
    title: 'photo',
    hasPreview: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    locale: 'en'
  }

  let checkAccessCalls: any[]
  let getFolderByIdCalls: any[]
  let moveAssetCalls: any[]
  let checkAccessResult: boolean

  let app: FastifyInstance

  before(async () => {
    checkAccessCalls = []
    getFolderByIdCalls = []
    moveAssetCalls = []
    checkAccessResult = true

    app = await buildTestApp({
      routes,
      wiki: {
        sites: { [SITE_ID]: { id: SITE_ID, isEnabled: true } },
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
            getFolderById: async (id: string, siteId: string) => {
              getFolderByIdCalls.push({ id, siteId })
              return id === DESTINATION_FOLDER_ID
                ? { id, siteId, folderPath: '', fileName: 'destination' }
                : null
            }
          },
          assets: {
            getAsset: async () => existingAsset,
            moveAsset: async (opts: any) => {
              moveAssetCalls.push(opts)
              return { ...existingAsset, folderPath: 'destination' }
            }
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  test('checks manage:assets at the current folder, then write:assets at the destination, in that order', async () => {
    checkAccessCalls = []
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/assets/${ASSET_ID}/folder`,
      payload: { folderId: DESTINATION_FOLDER_ID }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(checkAccessCalls.length, 2)
    assert.equal(checkAccessCalls[0].path, 'source/photo.png', 'first check: the CURRENT location')
    assert.equal(
      checkAccessCalls[1].path,
      'destination/photo.png',
      'second check: the DESTINATION location'
    )
  })

  test('a denied source permission (manage:assets) never resolves the destination or moves anything', async () => {
    checkAccessCalls = []
    getFolderByIdCalls = []
    moveAssetCalls = []
    checkAccessResult = false
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/sites/${SITE_ID}/assets/${ASSET_ID}/folder`,
        payload: { folderId: DESTINATION_FOLDER_ID }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(checkAccessCalls.length, 1)
      assert.equal(getFolderByIdCalls.length, 0)
      assert.equal(moveAssetCalls.length, 0)
    } finally {
      checkAccessResult = true
    }
  })

  test('a denied destination permission (write:assets) resolves the folder but never moves anything', async () => {
    checkAccessCalls = []
    moveAssetCalls = []
    getFolderByIdCalls = []
    // -> Allows the first (source) check and denies the second (destination)
    const originalCheckAccess = (globalThis as any).CARDINAL.models.groups.checkAccess
    ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
      _actor: any,
      _permission: string,
      page: any
    ) => {
      checkAccessCalls.push(page)
      return checkAccessCalls.length === 1
    }
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/sites/${SITE_ID}/assets/${ASSET_ID}/folder`,
        payload: { folderId: DESTINATION_FOLDER_ID }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(
        checkAccessCalls.length,
        2,
        'the destination folder must still have been resolved'
      )
      assert.equal(getFolderByIdCalls.length, 1)
      assert.equal(moveAssetCalls.length, 0)
    } finally {
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = originalCheckAccess
    }
  })

  test('folderId wins over parentPath, and never resolves the destination by path', async () => {
    getFolderByIdCalls = []
    moveAssetCalls = []
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/assets/${ASSET_ID}/folder`,
      payload: { folderId: DESTINATION_FOLDER_ID, parentPath: 'ignored/path' }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(
      getFolderByIdCalls.map((c) => c.id),
      [DESTINATION_FOLDER_ID]
    )
    assert.equal(moveAssetCalls.length, 1)
    assert.equal(moveAssetCalls[0].folderId, DESTINATION_FOLDER_ID)
    assert.equal(moveAssetCalls[0].parentPath, undefined)
  })

  test('an unresolvable folderId 404s outright, with no fallback to the site root (unlike upload)', async () => {
    getFolderByIdCalls = []
    moveAssetCalls = []
    checkAccessCalls = []
    const unknownFolderId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/assets/${ASSET_ID}/folder`,
      payload: { folderId: unknownFolderId }
    })
    assert.equal(res.statusCode, 404)
    assert.deepEqual(
      getFolderByIdCalls.map((c) => c.id),
      [unknownFolderId]
    )
    // -> Only the source check: the destination check never runs against an unresolved folder
    assert.equal(checkAccessCalls.length, 1)
    assert.equal(moveAssetCalls.length, 0)
  })

  test('an empty body (no folderId, no parentPath) moves to the site root', async () => {
    getFolderByIdCalls = []
    moveAssetCalls = []
    checkAccessCalls = []
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/assets/${ASSET_ID}/folder`,
      payload: {}
    })
    assert.equal(res.statusCode, 200)
    assert.equal(getFolderByIdCalls.length, 0)
    assert.equal(checkAccessCalls[1].path, 'photo.png', 'destination check runs against the root')
    assert.equal(moveAssetCalls[0].folderId, undefined)
    assert.equal(moveAssetCalls[0].parentPath, '')
  })

  test('a nonexistent asset 404s before any permission check', async () => {
    checkAccessCalls = []
    const originalGetAsset = (globalThis as any).CARDINAL.models.assets.getAsset
    ;(globalThis as any).CARDINAL.models.assets.getAsset = async () => null
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/sites/${SITE_ID}/assets/${ASSET_ID}/folder`,
        payload: { folderId: DESTINATION_FOLDER_ID }
      })
      assert.equal(res.statusCode, 404)
      assert.equal(checkAccessCalls.length, 0)
    } finally {
      ;(globalThis as any).CARDINAL.models.assets.getAsset = originalGetAsset
    }
  })

  test('moveAsset resolving to null (a race with a concurrent delete) answers 404', async () => {
    const originalMoveAsset = (globalThis as any).CARDINAL.models.assets.moveAsset
    ;(globalThis as any).CARDINAL.models.assets.moveAsset = async () => null
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/sites/${SITE_ID}/assets/${ASSET_ID}/folder`,
        payload: { folderId: DESTINATION_FOLDER_ID }
      })
      assert.equal(res.statusCode, 404)
    } finally {
      ;(globalThis as any).CARDINAL.models.assets.moveAsset = originalMoveAsset
    }
  })
})

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
          },
          // -> The upload route carries `limitUploads` as a preHandler; this suite always allows.
          rateLimits: {
            consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 })
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
      // -> Mixed case and wrapping slashes: the folder is created at the normalized path either
      //    way, so a rule written in normalized form must not be evadable by re-casing the request.
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
    const originalGetFolderById = (globalThis as any).CARDINAL.models.tree.getFolderById
    ;(globalThis as any).CARDINAL.models.tree.getFolderById = async (id: string) => {
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
      ;(globalThis as any).CARDINAL.models.tree.getFolderById = originalGetFolderById
    }
  })

  test('rejects a `folderId` belonging to another site (404, no upload, permission check never runs against the wrong destination)', async () => {
    getFolderByIdCalls = []
    checkAccessCalls = []
    uploadCalls = []
    const FOREIGN_SITE_ID = '99999999-9999-4999-8999-999999999999'
    const foreignFolderId = '88888888-8888-4888-8888-888888888888'
    const originalGetFolderById = (globalThis as any).CARDINAL.models.tree.getFolderById
    ;(globalThis as any).CARDINAL.models.tree.getFolderById = async (id: string) => {
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
      ;(globalThis as any).CARDINAL.models.tree.getFolderById = originalGetFolderById
    }
  })

  test('rejects a `folderId` whose folder row carries no matching siteId (404, no upload)', async () => {
    getFolderByIdCalls = []
    checkAccessCalls = []
    uploadCalls = []
    const missingFolderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    // FIXME: the title is wrong. The `before()` stub answers a row with no `siteId`, so this 404 is
    //    the route's wrong-site check; a genuinely unresolvable id (`null`) uploads to the root
    //    instead, as the test below asserts. Retitle, or drop as a duplicate of the test above.
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

  test('a folderId that does not resolve in this site is never passed through to upload()', async () => {
    getFolderCalls = []
    getFolderByIdCalls = []
    uploadCalls = []
    checkAccessCalls = []
    const foreignFolderId = '99999999-9999-4999-8999-999999999999'
    const originalGetFolderById = (globalThis as any).CARDINAL.models.tree.getFolderById
    ;(globalThis as any).CARDINAL.models.tree.getFolderById = async (id: string) => {
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
      // -> Checked against the root, not the foreign folder's path
      assert.equal(checkAccessCalls[0].path, 'photo.png')
      assert.equal(uploadCalls[0].folderId, undefined)
    } finally {
      ;(globalThis as any).CARDINAL.models.tree.getFolderById = originalGetFolderById
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

describe('UPLOAD ASSET route: rate limit (OpenProject #3234)', () => {
  const SITE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

  let uploadCalls: number
  let consumeCalls: { key: string }[]
  let allowed: boolean

  let app: FastifyInstance

  before(async () => {
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
            checkAccess: () => true
          },
          assets: {
            upload: async () => {
              uploadCalls++
              return { id: 'asset-1' }
            }
          },
          rateLimits: {
            consume: async (key: string) => {
              consumeCalls.push({ key })
              return allowed
                ? { allowed: true, hits: 1, retryAfter: 0 }
                : { allowed: false, hits: 21, retryAfter: 45 }
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

  test('a burst exceeding the limit is rejected with 429 and Retry-After, without reaching upload()', async () => {
    uploadCalls = 0
    consumeCalls = []
    allowed = false
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/assets?fileName=photo.png`,
      headers: { ...sessionHeader(), 'content-type': 'image/png' },
      payload: Buffer.from([1, 2, 3])
    })
    assert.equal(res.statusCode, 429)
    assert.equal(res.headers['retry-after'], '45')
    assert.equal(uploadCalls, 0)
    assert.equal(consumeCalls.length, 1)
    assert.equal(consumeCalls[0].key, 'upload:user-1')
  })

  test('normal single-file usage (one upload at a time) is unaffected', async () => {
    // -> The previous test's refusal is memoized in the shared `activeBanMemo`, which would refuse
    //    this request without ever reaching the `consume()` stub.
    activeBanMemo.clear()
    uploadCalls = 0
    consumeCalls = []
    allowed = true
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/assets?fileName=photo.png`,
      headers: { ...sessionHeader(), 'content-type': 'image/png' },
      payload: Buffer.from([1, 2, 3])
    })
    assert.equal(res.statusCode, 200)
    assert.equal(uploadCalls, 1)
    assert.equal(consumeCalls.length, 1)
  })
})

describe('GET asset route: image dimensions', () => {
  const SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const ASSET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

  const baseAsset = {
    id: ASSET_ID,
    fileName: 'photo.png',
    fileExt: 'png',
    kind: 'image',
    mimeType: 'image/png',
    fileSize: 3,
    folderPath: '',
    title: 'photo',
    hasPreview: true,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    locale: 'en'
  }

  let resolvedAsset: any
  let app: FastifyInstance

  before(async () => {
    app = await buildTestApp({
      routes,
      wiki: {
        sites: { [SITE_ID]: { id: SITE_ID, isEnabled: true } },
        config: { security: {} },
        models: {
          groups: {
            actorForRequest: () => ({ permissions: [] }),
            checkAccess: () => true
          },
          assets: { getAsset: async () => resolvedAsset }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  test('carries width and height in the response when the asset has them', async () => {
    resolvedAsset = { ...baseAsset, width: 640, height: 480 }
    const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/assets/${ASSET_ID}` })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().width, 640)
    assert.equal(res.json().height, 480)
  })

  test('carries neither key when the asset has no stored dimensions', async () => {
    resolvedAsset = { ...baseAsset, hasPreview: false }
    const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/assets/${ASSET_ID}` })
    assert.equal(res.statusCode, 200)
    assert.equal('width' in res.json(), false)
    assert.equal('height' in res.json(), false)
  })
})
