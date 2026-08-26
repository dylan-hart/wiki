import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import treeRoutes, { mayOnFolder, visibleTreeItems } from './tree.ts'
import { registerSchemas as registerTreeSchema } from './schemas/tree.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

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
  ;(globalThis as any).WIKI = {
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
        renameFolder: async (input: any) => ({
          ...input,
          siteId: ENABLED_SITE_ID,
          folderPath: '',
          locale: 'en',
          meta: {}
        }),
        listDescendantPages: async () => [],
        getTree: async () => [],
        // -> DELETE FOLDER's own default: no descendants, nothing to authorize. Tests covering
        //    OpenProject #2100 override this per-test.
        listDescendants: async () => ({ pages: [], assets: [] }),
        deleteFolder: async () => ({ pages: [], assets: [] })
      },
      groups: {
        actorForRequest: () => ({ permissions: [] }),
        // -> `actorFrom(req)` (DELETE FOLDER's session-to-actor resolution, `api/pages.ts`) reads this
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

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
  await app.register(fastifySensible)
  // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/`forbidden()`/`unauthorized()`
  //    is a thrown `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that
  //    shapes it into the `{ ok, error, statusCode, message }` the `ApiError#` response schema every
  //    route's 4xx entries reference requires. Needed here because DELETE FOLDER's #2100 tests are the
  //    first in this file to actually exercise a 4xx response.
  app.setErrorHandler((error: any, _req, reply) => {
    reply.code(error.statusCode ?? 500).send({
      ok: false,
      error: error.name,
      statusCode: error.statusCode ?? 500,
      message: error.message
    })
  })
  // -> Stands in for `@fastify/session`: every injected request arrives already logged in, which is
  //    what DELETE FOLDER's `actorFrom(req)` needs to get past its own 401 before authorization is
  //    even considered. No test in this file exercises the unauthenticated path.
  app.addHook('onRequest', async (req) => {
    ;(req as any).session = {
      authenticated: true,
      user: { id: 'user-1', email: 'user@example.com', name: 'User' },
      permissions: []
    }
  })
  await registerTreeSchema(app)
  await registerErrorSchema(app)
  await app.register(treeRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

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
  ;(globalThis as any).WIKI.models.tree.listDescendantPages = async () => [
    { path: 'sub/child', tags: [], classification: null }
  ]
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
  ;(globalThis as any).WIKI.models.tree.listDescendantPages = async () => [
    { path: 'sub/child', tags: [], classification: null }
  ]
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
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`
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
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`
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
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`
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
