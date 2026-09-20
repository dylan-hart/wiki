import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import treeRoutes from './tree.ts'
import { CustomError } from '../helpers/common.ts'
import { mayOnFolder, visibleTreeItems } from '../helpers/pageAccess.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

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
        listDescendants: async () => ({ pages: [], assets: [] }),
        deleteFolder: async () => ({ pages: [], assets: [] })
      },
      groups: {
        actorForRequest: () => ({ permissions: [] }),
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
    session: (req: any) => {
      const raw = req.headers['x-test-session']
      return typeof raw === 'string' ? JSON.parse(raw) : {}
    }
  })
})

after(() => closeTestApp(app))

test('visibleTreeItems: threads siteId into every filtered item, not just the first', () => {
  const calls: any[] = []
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
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
  assert.equal(calls[0].classification, 'classification-restricted')
  assert.equal(calls[1].classification, null)
})

test('mayOnFolder: threads siteId into the RulePageRef passed to checkAccess', () => {
  const calls: any[] = []
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
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
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
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
 * An absent `locale` handed to `getTree` would merge every locale, while `visibleTreeItems` judges
 * access as if the site's primary locale were the only one present.
 */
test('GET TREE route: getTree receives the same resolved locale visibleTreeItems judges by, when the query omits locale', async () => {
  let getTreeLocale: string | null | undefined = 'not called'
  ;(globalThis as any).CARDINAL.models.tree.getTree = async (args: any) => {
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

test('CREATE FOLDER route: a parentId that does not resolve in this site is refused, not silently created at root', async () => {
  const originalGetFolderById = (globalThis as any).CARDINAL.models.tree.getFolderById
  const originalCreateFolder = (globalThis as any).CARDINAL.models.tree.createFolder
  const getFolderByIdCalls: any[] = []
  let createFolderCalled = false
  ;(globalThis as any).CARDINAL.models.tree.getFolderById = async (id: string, siteId: string) => {
    getFolderByIdCalls.push({ id, siteId })
    return null
  }
  ;(globalThis as any).CARDINAL.models.tree.createFolder = async () => {
    createFolderCalled = true
    return {}
  }
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = () => true
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
    ;(globalThis as any).CARDINAL.models.tree.getFolderById = originalGetFolderById
    ;(globalThis as any).CARDINAL.models.tree.createFolder = originalCreateFolder
  }
})

test('CREATE FOLDER route: a parentId that resolves in this site creates as normal', async () => {
  const originalGetFolderById = (globalThis as any).CARDINAL.models.tree.getFolderById
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = () => true
  ;(globalThis as any).CARDINAL.models.tree.getFolderById = async (id: string) => ({
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
    ;(globalThis as any).CARDINAL.models.tree.getFolderById = originalGetFolderById
  }
})

/**
 * `getTree()` hides unpublished pages only under `publicOnly`; without it an anonymous request
 * learns that a draft exists.
 */
test('GET TREE route: passes publicOnly: true to getTree for an unauthenticated request', async () => {
  let receivedPublicOnly: boolean | undefined
  ;(globalThis as any).CARDINAL.models.tree.getTree = async (args: any) => {
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
  ;(globalThis as any).CARDINAL.models.tree.getTree = async (args: any) => {
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
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
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

test('RENAME FOLDER route: refuses when the caller lacks write:pages at the destination path, and does not rename', async () => {
  let renameCalled = false
  ;(globalThis as any).CARDINAL.models.tree.renameFolder = async () => {
    renameCalled = true
    return {}
  }
  ;(globalThis as any).CARDINAL.models.tree.listDescendants = async () => ({
    pages: [{ path: 'sub/child', tags: [], classification: null }],
    assets: []
  })
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
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
  ;(globalThis as any).CARDINAL.models.tree.renameFolder = async () => {
    renameCalled = true
    return {}
  }
  ;(globalThis as any).CARDINAL.models.tree.listDescendants = async () => ({
    pages: [{ path: 'sub/child', tags: [], classification: null }],
    assets: []
  })
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
    _actor: any,
    permission: string,
    page: any
  ) => !(permission === 'write:pages' && page.path === 'sub2/child')
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

test('DELETE FOLDER route: refused 403 when a descendant page fails delete:pages, deleting nothing', async () => {
  const deleteFolderCalls: any[] = []
  const permissionsChecked: string[] = []
  ;(globalThis as any).CARDINAL.models.tree.listDescendants = async (folderId: string) => {
    assert.equal(folderId, FOLDER_ID)
    return {
      pages: [{ path: 'sub/child', locale: 'en', tags: [], classification: null }],
      assets: []
    }
  }
  ;(globalThis as any).CARDINAL.models.tree.deleteFolder = async (folderId: string) => {
    deleteFolderCalls.push(folderId)
    return { pages: [], assets: [] }
  }
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
    _actor: any,
    permission: string,
    _page: any
  ) => {
    permissionsChecked.push(permission)
    return permission !== 'delete:pages'
  }
  const res = await app.inject({
    method: 'DELETE',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`,
    // -> The route answers 401 without a session user; the fixture's default session has none.
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
  ;(globalThis as any).CARDINAL.models.tree.listDescendants = async () => ({
    pages: [],
    assets: [{ folderPath: 'sub', fileName: 'file.png', locale: 'en' }]
  })
  ;(globalThis as any).CARDINAL.models.tree.deleteFolder = async (folderId: string) => {
    deleteFolderCalls.push(folderId)
    return { pages: [], assets: [] }
  }
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
    _actor: any,
    permission: string,
    _page: any
  ) => {
    permissionsChecked.push(permission)
    return permission !== 'manage:assets'
  }
  const res = await app.inject({
    method: 'DELETE',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`,
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
  ;(globalThis as any).CARDINAL.models.tree.listDescendants = async () => ({
    pages: [{ path: 'sub/child', locale: 'en', tags: ['x'], classification: 'internal' }],
    assets: [{ folderPath: 'sub', fileName: 'file.png', locale: 'en' }]
  })
  ;(globalThis as any).CARDINAL.models.tree.deleteFolder = async (folderId: string) => {
    deleteFolderCalls.push(folderId)
    return { pages: removedPages, assets: removedAssets }
  }
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = () => true
  ;(globalThis as any).CARDINAL.models.pages.deleteOrphaned = async (
    siteId: string,
    entries: any[],
    actor: any
  ) => {
    pagesDeleteOrphanedCalls.push({ siteId, entries, actor })
  }
  ;(globalThis as any).CARDINAL.models.assets.deleteOrphaned = async (
    siteId: string,
    entries: any[]
  ) => {
    assetsDeleteOrphanedCalls.push({ siteId, entries })
  }
  const res = await app.inject({
    method: 'DELETE',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}`,
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
 * The mock stands in for the siteId-scoped `getFolderById` resolving a foreign id to `null`: the
 * route itself must refuse, not fall through to the request's own `parentPath`.
 */
test('CREATE FOLDER route: refuses a foreign parentId and leaks neither a path nor a locale', async () => {
  const originalGetFolderById = (globalThis as any).CARDINAL.models.tree.getFolderById
  ;(globalThis as any).CARDINAL.models.tree.getFolderById = async () => null
  const foreignParentId = '99999999-9999-4999-8999-999999999999'
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders`,
    payload: { parentId: foreignParentId, pathName: 'intruder', title: 'Intruder' }
  })
  ;(globalThis as any).CARDINAL.models.tree.getFolderById = originalGetFolderById
  assert.equal(res.statusCode, 404)
  const body = res.json()
  assert.equal(body.message, 'The parent folder does not exist.')
  assert.equal('folder' in body, false, 'the response must not carry a folder object')
})

test('BROWSE THE TREE route: threads each item’s tags into the read:pages checkAccess call', async () => {
  const originalConfig = (globalThis as any).CARDINAL.sites[ENABLED_SITE_ID].config
  const originalBrowse = (globalThis as any).CARDINAL.models.tree.browse
  const originalCheckAccess = (globalThis as any).CARDINAL.models.groups.checkAccess
  ;(globalThis as any).CARDINAL.sites[ENABLED_SITE_ID].config = { features: { browse: true } }
  ;(globalThis as any).CARDINAL.models.tree.browse = async () => ({
    path: '',
    title: '',
    truncated: false,
    items: [
      {
        path: 'tagged-page',
        fileName: 'tagged-page',
        title: 'Tagged Page',
        icon: null,
        isPage: true,
        isFolder: false,
        classification: null,
        tags: ['alpha', 'beta']
      }
    ]
  })
  const calls: any[] = []
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
    _actor: any,
    _permission: any,
    page: any
  ) => {
    calls.push(page)
    return true
  }
  try {
    const res = await app.inject({ method: 'GET', url: `/sites/${ENABLED_SITE_ID}/tree/browse` })
    assert.equal(res.statusCode, 200)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].tags, ['alpha', 'beta'])
  } finally {
    ;(globalThis as any).CARDINAL.sites[ENABLED_SITE_ID].config = originalConfig
    ;(globalThis as any).CARDINAL.models.tree.browse = originalBrowse
    ;(globalThis as any).CARDINAL.models.groups.checkAccess = originalCheckAccess
  }
})

test('LIST PAGES AS A READER route: threads each page’s tags into the read:pages checkAccess call', async () => {
  const originalListPages = (globalThis as any).CARDINAL.models.tree.listPages
  const originalCheckAccess = (globalThis as any).CARDINAL.models.groups.checkAccess
  ;(globalThis as any).CARDINAL.models.tree.listPages = async () => [
    {
      id: 'page-1',
      path: 'tagged-list-page',
      title: 'Tagged List Page',
      description: '',
      icon: '',
      hasChildren: false,
      depth: 0,
      classification: null,
      tags: ['gamma']
    }
  ]
  const calls: any[] = []
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
    _actor: any,
    _permission: any,
    page: any
  ) => {
    calls.push(page)
    return true
  }
  try {
    const res = await app.inject({ method: 'GET', url: `/sites/${ENABLED_SITE_ID}/tree/pages` })
    assert.equal(res.statusCode, 200)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].tags, ['gamma'])
  } finally {
    ;(globalThis as any).CARDINAL.models.tree.listPages = originalListPages
    ;(globalThis as any).CARDINAL.models.groups.checkAccess = originalCheckAccess
  }
})

const DEST_ID = '66666666-6666-4666-8666-666666666666'

function withMoveFolderMocks(overrides: {
  getFolderById?: (id: string) => any
  listDescendants?: () => any
  moveFolder?: (input: any) => any
  checkAccess?: (actor: any, permission: string, page: any) => boolean
}) {
  const tree = (globalThis as any).CARDINAL.models.tree
  const groups = (globalThis as any).CARDINAL.models.groups
  const saved = {
    getFolderById: tree.getFolderById,
    listDescendants: tree.listDescendants,
    moveFolder: tree.moveFolder,
    checkAccess: groups.checkAccess
  }
  tree.getFolderById = async (id: string) =>
    overrides.getFolderById
      ? overrides.getFolderById(id)
      : id === DEST_ID
        ? { id, siteId: ENABLED_SITE_ID, fileName: 'dest', folderPath: '', locale: 'en', meta: {} }
        : { id, siteId: ENABLED_SITE_ID, fileName: 'sub', folderPath: '', locale: 'en', meta: {} }
  tree.listDescendants = overrides.listDescendants ?? (async () => ({ pages: [], assets: [] }))
  tree.moveFolder =
    overrides.moveFolder ??
    (async (input: any) => ({
      id: input.folderId,
      siteId: ENABLED_SITE_ID,
      fileName: 'sub',
      folderPath: 'dest',
      locale: 'en',
      meta: {}
    }))
  groups.checkAccess = overrides.checkAccess ?? (() => true)
  return () => {
    tree.getFolderById = saved.getFolderById
    tree.listDescendants = saved.listDescendants
    tree.moveFolder = saved.moveFolder
    groups.checkAccess = saved.checkAccess
  }
}

test('MOVE FOLDER route: moves into a destination folder, passing the resolved destination to moveFolder', async () => {
  const calls: any[] = []
  const restore = withMoveFolderMocks({
    moveFolder: async (input: any) => {
      calls.push(input)
      return {
        id: input.folderId,
        siteId: ENABLED_SITE_ID,
        fileName: 'sub',
        folderPath: 'dest',
        locale: 'en',
        meta: { children: 2 }
      }
    }
  })
  try {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
      payload: { folderId: DEST_ID }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].siteId, ENABLED_SITE_ID)
    assert.equal(calls[0].folderId, FOLDER_ID)
    assert.equal(calls[0].destinationId, DEST_ID)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.folder.folderPath, 'dest')
    assert.equal(body.folder.childrenCount, 2)
  } finally {
    restore()
  }
})

test('MOVE FOLDER route: a parentPath destination is normalized, and no body moves to the site root', async () => {
  const calls: any[] = []
  const restore = withMoveFolderMocks({
    getFolderById: (id: string) => ({
      id,
      siteId: ENABLED_SITE_ID,
      fileName: 'sub',
      folderPath: 'elsewhere',
      locale: 'en',
      meta: {}
    }),
    moveFolder: async (input: any) => {
      calls.push(input)
      return { id: input.folderId, fileName: 'sub', folderPath: '', locale: 'en', meta: {} }
    }
  })
  try {
    const withPath = await app.inject({
      method: 'PUT',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
      payload: { parentPath: '/Guides/Intro/' }
    })
    assert.equal(withPath.statusCode, 200)
    assert.equal(calls[0].parentPath, 'guides/intro')
    assert.equal(calls[0].destinationId, undefined)

    const toRoot = await app.inject({
      method: 'PUT',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
      payload: {}
    })
    assert.equal(toRoot.statusCode, 200)
    assert.equal(calls[1].parentPath, '')
  } finally {
    restore()
  }
})

test('MOVE FOLDER route: an unknown folder is a 404, and an unresolvable destination id is a 404 that moves nothing', async () => {
  let moveCalled = false
  let restore = withMoveFolderMocks({
    getFolderById: () => null,
    moveFolder: async () => {
      moveCalled = true
      return {}
    }
  })
  try {
    const missing = await app.inject({
      method: 'PUT',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
      payload: { folderId: DEST_ID }
    })
    assert.equal(missing.statusCode, 404)
  } finally {
    restore()
  }
  restore = withMoveFolderMocks({
    getFolderById: (id: string) =>
      id === FOLDER_ID
        ? { id, siteId: ENABLED_SITE_ID, fileName: 'sub', folderPath: '', locale: 'en', meta: {} }
        : null,
    moveFolder: async () => {
      moveCalled = true
      return {}
    }
  })
  try {
    const noDest = await app.inject({
      method: 'PUT',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
      payload: { folderId: DEST_ID, parentPath: 'fallback' }
    })
    assert.equal(noDest.statusCode, 404)
    assert.equal(noDest.json().message, 'The destination folder does not exist.')
  } finally {
    restore()
  }
  assert.equal(moveCalled, false)
})

test('MOVE FOLDER route: refuses a move into the folder itself or its own subtree, by segment boundary', async () => {
  const moves: any[] = []
  const restore = withMoveFolderMocks({
    moveFolder: async (input: any) => {
      moves.push(input)
      return { id: input.folderId, fileName: 'sub', folderPath: '', locale: 'en', meta: {} }
    }
  })
  try {
    for (const parentPath of ['sub', 'sub/inner/deeper']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
        payload: { parentPath }
      })
      assert.equal(res.statusCode, 400, parentPath)
    }
    assert.equal(moves.length, 0)

    const sibling = await app.inject({
      method: 'PUT',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
      payload: { parentPath: 'sub-archive' }
    })
    assert.equal(
      sibling.statusCode,
      200,
      'a name that merely starts with the folder name is not inside it'
    )
    assert.equal(moves.length, 1)
  } finally {
    restore()
  }
})

test('MOVE FOLDER route: refuses without manage:pages at the source or write:pages at the destination, and moves nothing', async () => {
  let moveCalled = false
  const moveFolder = async () => {
    moveCalled = true
    return {}
  }
  let restore = withMoveFolderMocks({
    moveFolder,
    checkAccess: (_actor, permission) => permission !== 'manage:pages'
  })
  try {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
      payload: { folderId: DEST_ID }
    })
    assert.equal(res.statusCode, 403)
  } finally {
    restore()
  }
  restore = withMoveFolderMocks({
    moveFolder,
    checkAccess: (_actor, permission, page) =>
      !(permission === 'write:pages' && page.path === 'dest/sub')
  })
  try {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
      payload: { folderId: DEST_ID }
    })
    assert.equal(res.statusCode, 403)
  } finally {
    restore()
  }
  assert.equal(moveCalled, false)
})

test('MOVE FOLDER route: one unauthorized descendant page refuses the whole move', async () => {
  let moveCalled = false
  const checked: { permission: string; path: string }[] = []
  const restore = withMoveFolderMocks({
    listDescendants: async () => ({
      pages: [
        { path: 'sub/ok', locale: 'en', tags: [], classification: null },
        { path: 'sub/inner/secret', locale: 'en', tags: ['x'], classification: null }
      ],
      assets: []
    }),
    moveFolder: async () => {
      moveCalled = true
      return {}
    },
    checkAccess: (_actor, permission, page) => {
      checked.push({ permission, path: page.path })
      return !(permission === 'write:pages' && page.path === 'dest/sub/inner/secret')
    }
  })
  try {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
      payload: { folderId: DEST_ID }
    })
    assert.equal(res.statusCode, 403)
    assert.ok(checked.some((c) => c.permission === 'manage:pages' && c.path === 'sub/ok'))
    assert.ok(checked.some((c) => c.permission === 'write:pages' && c.path === 'dest/sub/ok'))
    assert.equal(moveCalled, false)
  } finally {
    restore()
  }
})

test('MOVE FOLDER route: descendant assets need manage:assets at the source and write:assets at the destination', async () => {
  let moveCalled = false
  const checked: { permission: string; path: string }[] = []
  const asset = {
    id: 'a1',
    path: 'sub/inner/file.png',
    folderPath: 'sub/inner',
    fileName: 'file.png',
    locale: 'en'
  }
  for (const denied of ['manage:assets', 'write:assets']) {
    const restore = withMoveFolderMocks({
      listDescendants: async () => ({ pages: [], assets: [asset] }),
      moveFolder: async () => {
        moveCalled = true
        return {}
      },
      checkAccess: (_actor, permission, page) => {
        checked.push({ permission, path: page.path })
        return permission !== denied
      }
    })
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
        payload: { folderId: DEST_ID }
      })
      assert.equal(res.statusCode, 403, denied)
    } finally {
      restore()
    }
  }
  assert.equal(moveCalled, false)
  assert.ok(
    checked.some((c) => c.permission === 'manage:assets' && c.path === 'sub/inner/file.png')
  )
  assert.ok(
    checked.some((c) => c.permission === 'write:assets' && c.path === 'dest/sub/inner/file.png')
  )
})

test('MOVE FOLDER route: a fully authorized folder with pages and assets moves', async () => {
  const calls: any[] = []
  const restore = withMoveFolderMocks({
    listDescendants: async () => ({
      pages: [{ path: 'sub/page', locale: 'en', tags: [], classification: null }],
      assets: [{ id: 'a1', path: 'sub/f.png', folderPath: 'sub', fileName: 'f.png', locale: 'en' }]
    }),
    moveFolder: async (input: any) => {
      calls.push(input)
      return { id: input.folderId, fileName: 'sub', folderPath: 'dest', locale: 'en', meta: {} }
    }
  })
  try {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
      payload: { folderId: DEST_ID }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(calls.length, 1)
  } finally {
    restore()
  }
})

test('MOVE FOLDER route: a 409 name collision from the model surfaces as 409', async () => {
  const restore = withMoveFolderMocks({
    moveFolder: async () => {
      throw new CustomError(
        'treeFolderDuplicate',
        'A folder with this path name already exists.',
        409
      )
    }
  })
  try {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/parent`,
      payload: { folderId: DEST_ID }
    })
    assert.equal(res.statusCode, 409)
  } finally {
    restore()
  }
})
