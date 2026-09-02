import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import treeRoutes from './tree.ts'
import { mayOnFolder, visibleTreeItems } from '../helpers/pageAccess.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Regression tests for task 676: `visibleTreeItems` and `mayOnFolder` take an explicit `siteId` and
 * thread it into the `RulePageRef`(s) given to `checkAccess`, so a page rule scoped to one site (task
 * 671) is enforced when browsing or managing the tree, not just when reading a single page.
 *
 * `visibleTreeItems` filters an array rather than gating one request, so the direct test asserts the
 * siteId lands on every filtered item's page ref, not just the first.
 */

const ENABLED_SITE_ID = '11111111-1111-4111-8111-111111111111'
const FOLDER_ID = '55555555-5555-4555-8555-555555555555'

let app: FastifyInstance

before(async () => {
  const wiki = {
    sites: { [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, isEnabled: true, config: {} } },
    models: {
      tree: {
        getFolderById: async () => ({
          id: FOLDER_ID,
          siteId: ENABLED_SITE_ID,
          fileName: 'sub',
          folderPath: '',
          locale: 'en',
          meta: {}
        }),
        createFolder: async (input: any) => ({
          ...input,
          id: FOLDER_ID,
          fileName: input.pathName,
          folderPath: '',
          meta: {}
        }),
        renameFolder: async (input: any) => ({
          ...input,
          siteId: ENABLED_SITE_ID,
          folderPath: '',
          locale: 'en',
          meta: {}
        }),
        getTree: async () => [],
        // -> The RENAME and DELETE FOLDER routes' shared default: no descendants, nothing to
        //    authorize. Tests covering OpenProject #2100/#2102 override this per-test.
        listDescendants: async () => ({ pages: [], assets: [] }),
        deleteFolder: async () => ({ pages: [], assets: [] })
      },
      groups: {
        actorForRequest: () => ({ permissions: [] }),
        // -> `actorFrom(req)` (DELETE FOLDER's session-to-actor resolution, `helpers/pageAccess.ts`) reads this
        //    for a session-backed request.
        groupIdsForRequest: () => []
      },
      pages: {
        deleteOrphaned: async () => {}
      },
      assets: {
        deleteOrphaned: async () => {}
      }
    }
  }

  app = await buildTestApp({
    routes: treeRoutes,
    ajv: true,
    wiki,
    // -> Stands in for the real session plugin: a request carrying `x-test-session` gets the session
    //    it names, exactly the shape `!req.session?.authenticated` in BROWSE THE TREE's handler
    //    reads, and what DELETE FOLDER's `actorFrom(req)` needs to get past its own 401 -- tests
    //    exercising that route send the header explicitly (`sessionHeader()`), so the default here
    //    stays unauthenticated, matching the existing "publicOnly: true for an unauthenticated
    //    request" coverage below.
    session: (req: any) => {
      const raw = req.headers['x-test-session']
      return typeof raw === 'string' ? JSON.parse(raw) : {}
    }
  })
})

after(() => closeTestApp(app))

test('visibleTreeItems: threads siteId into every filtered item, not just the first', () => {
  const calls: any[] = []
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => {
    calls.push(page)
    return true
  }
  const items = [
    { type: 'page', fileName: 'a', folderPath: '', classification: 'classification-restricted' },
    { type: 'asset', fileName: 'b.png', folderPath: 'folder' }
  ]
  const result = visibleTreeItems({} as any, ENABLED_SITE_ID, 'en', items)
  assert.equal(result.length, 2)
  assert.equal(calls.length, 2)
  for (const page of calls) {
    assert.equal(page.siteId, ENABLED_SITE_ID)
    assert.equal(page.locale, 'en')
  }
  assert.equal(calls[0].path, 'a')
  assert.equal(calls[1].path, 'folder/b.png')
  // -> OpenProject #1128: the item's own real classification reaches checkAccess, not a hardcoded
  //    null -- and an item that carries none (an asset, or a page from before this fix) still falls
  //    back to null rather than `undefined`.
  assert.equal(calls[0].classification, 'classification-restricted')
  assert.equal(calls[1].classification, null)
})

test('mayOnFolder: threads siteId into the RulePageRef passed to checkAccess', () => {
  const calls: any[] = []
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => {
    calls.push(page)
    return true
  }
  const result = mayOnFolder({} as any, 'read:pages', ENABLED_SITE_ID, 'foo/bar', 'en')
  assert.equal(result, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].siteId, ENABLED_SITE_ID)
  assert.equal(calls[0].path, 'foo/bar')
  assert.equal(calls[0].locale, 'en')
})

test('GET FOLDER route: passes the route siteId through to checkAccess', async () => {
  const calls: any[] = []
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => {
    calls.push(page)
    return true
  }
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].siteId, ENABLED_SITE_ID)
})

/**
 * Review finding (#992): the GET tree route resolved a defaulted locale for `visibleTreeItems` but
 * passed the raw, possibly-absent query param straight through to `getTree` — an omitted `locale`
 * merged every locale out of `getTree` while `visibleTreeItems` judged access as if the site's
 * primary locale were the only one present. The handler now resolves one `const locale` and passes
 * it to both.
 */
test('GET TREE route: getTree receives the same resolved locale visibleTreeItems judges by, when the query omits locale', async () => {
  let getTreeLocale: string | null | undefined = 'not called'
  ;(globalThis as any).WIKI.models.tree.getTree = async (args: any) => {
    getTreeLocale = args.locale
    return []
  }
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${ENABLED_SITE_ID}/tree`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(getTreeLocale, 'en', "getTree must receive the site's resolved default locale")
})

/**
 * OpenProject #2131: a `parentId` belonging to another site used to resolve unscoped, leaking
 * that other site's folder path/locale into the created folder's response. `getFolderById` is now
 * siteId-scoped, so a foreign id resolves to nothing and the handler refuses outright rather than
 * silently falling back to the site root.
 */
test('CREATE FOLDER route: a parentId that does not resolve in this site is refused, not silently created at root', async () => {
  const originalGetFolderById = (globalThis as any).WIKI.models.tree.getFolderById
  const originalCreateFolder = (globalThis as any).WIKI.models.tree.createFolder
  const getFolderByIdCalls: any[] = []
  let createFolderCalled = false
  ;(globalThis as any).WIKI.models.tree.getFolderById = async (id: string, siteId: string) => {
    getFolderByIdCalls.push({ id, siteId })
    return null
  }
  ;(globalThis as any).WIKI.models.tree.createFolder = async () => {
    createFolderCalled = true
    return {}
  }
  ;(globalThis as any).WIKI.models.groups.checkAccess = () => true
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders`,
      payload: {
        parentId: '99999999-9999-4999-8999-999999999999',
        pathName: 'sub',
        title: 'Sub'
      }
    })
    assert.equal(res.statusCode, 404)
    assert.deepEqual(getFolderByIdCalls, [
      { id: '99999999-9999-4999-8999-999999999999', siteId: ENABLED_SITE_ID }
    ])
    assert.equal(createFolderCalled, false)
  } finally {
    ;(globalThis as any).WIKI.models.tree.getFolderById = originalGetFolderById
    ;(globalThis as any).WIKI.models.tree.createFolder = originalCreateFolder
  }
})

test('CREATE FOLDER route: a parentId that resolves in this site creates as normal', async () => {
  const originalGetFolderById = (globalThis as any).WIKI.models.tree.getFolderById
  ;(globalThis as any).WIKI.models.groups.checkAccess = () => true
  ;(globalThis as any).WIKI.models.tree.getFolderById = async (id: string) => ({
    id,
    siteId: ENABLED_SITE_ID,
    fileName: 'parent',
    folderPath: '',
    locale: 'en',
    meta: {}
  })
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders`,
      payload: {
        parentId: FOLDER_ID,
        pathName: 'sub',
        title: 'Sub'
      }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
  } finally {
    ;(globalThis as any).WIKI.models.tree.getFolderById = originalGetFolderById
  }
})

/**
 * OpenProject #1599: BROWSE THE TREE (`GET /sites/:siteId/tree`) called `getTree()` without a
 * `publicOnly` argument, so `getTree()` never applied `pageIsVisible()` and an anonymous request
 * could be told a draft, a not-yet-scheduled page, or an `isBrowsable: false` page exists. The
 * handler now resolves `publicOnly` from the session the same way `tree.browse()`'s route already
 * does, and passes it through.
 */
test('GET TREE route: passes publicOnly: true to getTree for an unauthenticated request', async () => {
  let receivedPublicOnly: boolean | undefined
  ;(globalThis as any).WIKI.models.tree.getTree = async (args: any) => {
    receivedPublicOnly = args.publicOnly
    return []
  }
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${ENABLED_SITE_ID}/tree`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(receivedPublicOnly, true)
})

test('GET TREE route: passes publicOnly: false to getTree for an authenticated request', async () => {
  let receivedPublicOnly: boolean | undefined
  ;(globalThis as any).WIKI.models.tree.getTree = async (args: any) => {
    receivedPublicOnly = args.publicOnly
    return []
  }
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${ENABLED_SITE_ID}/tree`,
    headers: { 'x-test-session': JSON.stringify({ authenticated: true }) }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(receivedPublicOnly, false)
})

test('RENAME FOLDER route: passes the route siteId through to checkAccess', async () => {
  const calls: any[] = []
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => {
    calls.push(page)
    return true
  }
  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`,
    payload: { pathName: 'sub', title: 'Sub' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].siteId, ENABLED_SITE_ID)
})

/**
 * OpenProject #2102: renaming a folder used to authorize only the folder's own CURRENT path with
 * `manage:pages`, then let `renameFolder()` rewrite every descendant's path unchecked -- a group
 * holding ALLOW `manage:pages` at the site root plus a narrower DENY somewhere under the folder
 * passed the gate at the folder and had the denied branch moved to a path the DENY no longer
 * addressed. Renaming now also requires `write:pages` at the destination, for the folder itself and
 * for every descendant page.
 */
test('RENAME FOLDER route: refuses when the caller lacks write:pages at the destination path, and does not rename', async () => {
  let renameCalled = false
  ;(globalThis as any).WIKI.models.tree.renameFolder = async () => {
    renameCalled = true
    return {}
  }
  ;(globalThis as any).WIKI.models.tree.listDescendants = async () => ({
    pages: [{ path: 'sub/child', tags: [], classification: null }],
    assets: []
  })
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    permission: string,
    page: any
  ) => !(permission === 'write:pages' && page.path === 'sub2')
  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`,
    payload: { pathName: 'sub2', title: 'Sub' }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(renameCalled, false, 'renameFolder must not run when the destination is refused')
})

test('RENAME FOLDER route: refuses when a descendant page would land where the caller lacks write:pages, and does not rename', async () => {
  let renameCalled = false
  ;(globalThis as any).WIKI.models.tree.renameFolder = async () => {
    renameCalled = true
    return {}
  }
  ;(globalThis as any).WIKI.models.tree.listDescendants = async () => ({
    pages: [{ path: 'sub/child', tags: [], classification: null }],
    assets: []
  })
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    permission: string,
    page: any
  ) =>
    // -> The folder itself is allowed both at its current path and at the destination; only the
    //    descendant's own destination is refused -- the escalation this exists to close.
    !(permission === 'write:pages' && page.path === 'sub2/child')
  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`,
    payload: { pathName: 'sub2', title: 'Sub' }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(
    renameCalled,
    false,
    'renameFolder must not run when a descendant destination is refused'
  )
})

/**
 * OpenProject #2100: DELETE FOLDER cascades to every descendant page and asset, but used to authorize
 * only the folder's own path (`manage:pages`) -- `delete:pages` was never checked at all, and no asset
 * permission was checked at all. The route now enumerates descendants first
 * (`WIKI.models.tree.listDescendants`) and requires `delete:pages` on every descendant page and
 * `manage:assets` on every descendant asset before calling `deleteFolder`, refusing (403) and deleting
 * nothing the moment a single descendant fails -- the same all-or-nothing shape the page move route's
 * `includeTranslations` uses.
 */
test('DELETE FOLDER route: refused 403 when a descendant page fails delete:pages, deleting nothing', async () => {
  const deleteFolderCalls: any[] = []
  const permissionsChecked: string[] = []
  ;(globalThis as any).WIKI.models.tree.listDescendants = async (folderId: string) => {
    assert.equal(folderId, FOLDER_ID)
    return {
      pages: [{ path: 'sub/child', locale: 'en', tags: [], classification: null }],
      assets: []
    }
  }
  ;(globalThis as any).WIKI.models.tree.deleteFolder = async (folderId: string) => {
    deleteFolderCalls.push(folderId)
    return { pages: [], assets: [] }
  }
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    permission: string,
    _page: any
  ) => {
    permissionsChecked.push(permission)
    // -> The folder's own `manage:pages` check passes; the descendant page's `delete:pages` does not.
    return permission !== 'delete:pages'
  }
  const res = await app.inject({
    method: 'DELETE',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`,
    // -> DELETE FOLDER's `actorFrom(req)` needs an authenticated session to get past its own 401;
    //    the shared fixture's default session is unauthenticated (see the `before()` hook above).
    headers: { 'x-test-session': JSON.stringify({ authenticated: true, user: { id: 'user-1' } }) }
  })
  assert.equal(res.statusCode, 403)
  assert.ok(
    permissionsChecked.includes('delete:pages'),
    'must check delete:pages on the descendant'
  )
  assert.equal(
    deleteFolderCalls.length,
    0,
    'deleteFolder must not run once a descendant is refused'
  )
})

test('DELETE FOLDER route: refused 403 when a descendant asset fails manage:assets, deleting nothing', async () => {
  const deleteFolderCalls: any[] = []
  const permissionsChecked: string[] = []
  ;(globalThis as any).WIKI.models.tree.listDescendants = async () => ({
    pages: [],
    assets: [{ folderPath: 'sub', fileName: 'file.png', locale: 'en' }]
  })
  ;(globalThis as any).WIKI.models.tree.deleteFolder = async (folderId: string) => {
    deleteFolderCalls.push(folderId)
    return { pages: [], assets: [] }
  }
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    permission: string,
    _page: any
  ) => {
    permissionsChecked.push(permission)
    // -> The folder's own `manage:pages` check passes; the descendant asset's `manage:assets` does not.
    return permission !== 'manage:assets'
  }
  const res = await app.inject({
    method: 'DELETE',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`,
    // -> DELETE FOLDER's `actorFrom(req)` needs an authenticated session to get past its own 401;
    //    the shared fixture's default session is unauthenticated (see the `before()` hook above).
    headers: { 'x-test-session': JSON.stringify({ authenticated: true, user: { id: 'user-1' } }) }
  })
  assert.equal(res.statusCode, 403)
  assert.ok(
    permissionsChecked.includes('manage:assets'),
    'must check manage:assets on the descendant'
  )
  assert.equal(
    deleteFolderCalls.length,
    0,
    'deleteFolder must not run once a descendant is refused'
  )
})

test('DELETE FOLDER route: still cascades as before once every descendant is authorized', async () => {
  const deleteFolderCalls: any[] = []
  const pagesDeleteOrphanedCalls: any[] = []
  const assetsDeleteOrphanedCalls: any[] = []
  const removedPages = [{ id: 'p1', folderPath: 'sub', fileName: 'child', locale: 'en' }]
  const removedAssets = [{ id: 'a1', folderPath: 'sub', fileName: 'file.png', locale: 'en' }]
  ;(globalThis as any).WIKI.models.tree.listDescendants = async () => ({
    pages: [{ path: 'sub/child', locale: 'en', tags: ['x'], classification: 'internal' }],
    assets: [{ folderPath: 'sub', fileName: 'file.png', locale: 'en' }]
  })
  ;(globalThis as any).WIKI.models.tree.deleteFolder = async (folderId: string) => {
    deleteFolderCalls.push(folderId)
    return { pages: removedPages, assets: removedAssets }
  }
  ;(globalThis as any).WIKI.models.groups.checkAccess = () => true
  ;(globalThis as any).WIKI.models.pages.deleteOrphaned = async (
    siteId: string,
    entries: any[],
    actor: any
  ) => {
    pagesDeleteOrphanedCalls.push({ siteId, entries, actor })
  }
  ;(globalThis as any).WIKI.models.assets.deleteOrphaned = async (
    siteId: string,
    entries: any[]
  ) => {
    assetsDeleteOrphanedCalls.push({ siteId, entries })
  }
  const res = await app.inject({
    method: 'DELETE',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`,
    // -> DELETE FOLDER's `actorFrom(req)` needs an authenticated session to get past its own 401;
    //    the shared fixture's default session is unauthenticated (see the `before()` hook above).
    headers: { 'x-test-session': JSON.stringify({ authenticated: true, user: { id: 'user-1' } }) }
  })
  assert.equal(res.statusCode, 204)
  assert.equal(deleteFolderCalls.length, 1)
  assert.equal(deleteFolderCalls[0], FOLDER_ID)
  assert.equal(pagesDeleteOrphanedCalls.length, 1)
  assert.deepEqual(pagesDeleteOrphanedCalls[0].entries, removedPages)
  assert.equal(pagesDeleteOrphanedCalls[0].siteId, ENABLED_SITE_ID)
  assert.equal(pagesDeleteOrphanedCalls[0].actor.id, 'user-1')
  assert.equal(assetsDeleteOrphanedCalls.length, 1)
  assert.deepEqual(assetsDeleteOrphanedCalls[0].entries, removedAssets)
  assert.equal(assetsDeleteOrphanedCalls[0].siteId, ENABLED_SITE_ID)
})

/**
 * OpenProject #2131: a `parentId` naming a folder in another site used to be resolved anyway (the
 * model's `getFolderById()` filtered on `id` alone) and its path/locale flowed straight into the
 * response. `getFolderById` now takes the route's own siteId, so a foreign `parentId` resolves to
 * `null` here (this suite's mock ignores the id — the model layer's own DB-backed refusal is
 * `models/tree.test.ts`'s `createFolder refuses a parentId belonging to another site`) and the route
 * must refuse the request itself rather than falling through to the request's own `parentPath`.
 */
test('CREATE FOLDER route: refuses a foreign parentId and leaks neither a path nor a locale', async () => {
  const originalGetFolderById = (globalThis as any).WIKI.models.tree.getFolderById
  ;(globalThis as any).WIKI.models.tree.getFolderById = async () => null
  const foreignParentId = '99999999-9999-4999-8999-999999999999'
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders`,
    payload: { parentId: foreignParentId, pathName: 'intruder', title: 'Intruder' }
  })
  ;(globalThis as any).WIKI.models.tree.getFolderById = originalGetFolderById
  assert.equal(res.statusCode, 404)
  const body = res.json()
  assert.equal(body.message, 'The parent folder does not exist.')
  assert.equal('folder' in body, false, 'the response must not carry a folder object')
})
