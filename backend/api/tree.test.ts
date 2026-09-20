import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import treeRoutes from './tree.ts'
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

const PURGE_URL = `/sites/${ENABLED_SITE_ID}/tree/folders/purge-empty`
const SIGNED_IN = JSON.stringify({ authenticated: true, user: { id: 'user-1' } })

function stubPurge(candidates: { id: string; path: string; locale: string }[]) {
  const cardinal = (globalThis as any).CARDINAL
  const originals = {
    purgeEmptyFolders: cardinal.models.tree.purgeEmptyFolders,
    listDescendants: cardinal.models.tree.listDescendants,
    deleteFolder: cardinal.models.tree.deleteFolder,
    checkAccess: cardinal.models.groups.checkAccess
  }
  const purgeCalls: any[] = []
  const deleted: string[] = []
  cardinal.models.tree.purgeEmptyFolders = async (siteId: string, options: any) => {
    purgeCalls.push({ siteId, options })
    return { folders: candidates, count: candidates.length, dryRun: options.dryRun }
  }
  cardinal.models.tree.listDescendants = async () => ({ pages: [], assets: [] })
  cardinal.models.tree.deleteFolder = async (folderId: string) => {
    deleted.push(folderId)
    return { pages: [], assets: [] }
  }
  cardinal.models.groups.checkAccess = () => true
  return {
    purgeCalls,
    deleted,
    restore() {
      cardinal.models.tree.purgeEmptyFolders = originals.purgeEmptyFolders
      cardinal.models.tree.listDescendants = originals.listDescendants
      cardinal.models.tree.deleteFolder = originals.deleteFolder
      cardinal.models.groups.checkAccess = originals.checkAccess
    }
  }
}

const NESTED_CANDIDATES = [
  { id: 'c-deep', path: 'a/b', locale: 'en' },
  { id: 'c-top', path: 'a', locale: 'en' },
  { id: 'c-other', path: 'z', locale: 'en' }
]

test('PURGE EMPTY FOLDERS route: an unauthenticated request is refused 401 and reads nothing', async () => {
  const stub = stubPurge(NESTED_CANDIDATES)
  try {
    const res = await app.inject({ method: 'POST', url: PURGE_URL, payload: { dryRun: false } })
    assert.equal(res.statusCode, 401)
    assert.equal(stub.purgeCalls.length, 0)
    assert.equal(stub.deleted.length, 0)
  } finally {
    stub.restore()
  }
})

test('PURGE EMPTY FOLDERS route: a bare call is a dry run, reporting the count and deleting nothing', async () => {
  const stub = stubPurge(NESTED_CANDIDATES)
  try {
    const res = await app.inject({
      method: 'POST',
      url: PURGE_URL,
      headers: { 'x-test-session': SIGNED_IN }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { dryRun: true, count: 3, folders: NESTED_CANDIDATES })
    assert.deepEqual(stub.purgeCalls, [{ siteId: ENABLED_SITE_ID, options: { dryRun: true } }])
    assert.deepEqual(stub.deleted, [])
  } finally {
    stub.restore()
  }
})

test('PURGE EMPTY FOLDERS route: an explicit dryRun true deletes nothing either', async () => {
  const stub = stubPurge(NESTED_CANDIDATES)
  try {
    const res = await app.inject({
      method: 'POST',
      url: PURGE_URL,
      headers: { 'x-test-session': SIGNED_IN },
      payload: { dryRun: true }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().dryRun, true)
    assert.equal(res.json().count, 3)
    assert.deepEqual(stub.deleted, [])
  } finally {
    stub.restore()
  }
})

test('PURGE EMPTY FOLDERS route: dryRun false removes exactly the reported folders, deepest first', async () => {
  const stub = stubPurge(NESTED_CANDIDATES)
  try {
    const res = await app.inject({
      method: 'POST',
      url: PURGE_URL,
      headers: { 'x-test-session': SIGNED_IN },
      payload: { dryRun: false }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { dryRun: false, count: 3, folders: NESTED_CANDIDATES })
    assert.deepEqual(stub.deleted, ['c-deep', 'c-top', 'c-other'])
  } finally {
    stub.restore()
  }
})

test('PURGE EMPTY FOLDERS route: a folder the caller cannot manage is neither reported nor purged', async () => {
  const stub = stubPurge(NESTED_CANDIDATES)
  const permissionsChecked: string[] = []
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
    _actor: any,
    permission: string,
    page: any
  ) => {
    permissionsChecked.push(permission)
    return page.path !== 'z'
  }
  try {
    const dry = await app.inject({
      method: 'POST',
      url: PURGE_URL,
      headers: { 'x-test-session': SIGNED_IN }
    })
    assert.equal(dry.statusCode, 200)
    assert.deepEqual(
      dry.json().folders.map((f: any) => f.id),
      ['c-deep', 'c-top']
    )
    assert.equal(dry.json().count, 2)
    const real = await app.inject({
      method: 'POST',
      url: PURGE_URL,
      headers: { 'x-test-session': SIGNED_IN },
      payload: { dryRun: false }
    })
    assert.equal(real.statusCode, 200)
    assert.equal(real.json().count, 2)
    assert.deepEqual(stub.deleted, ['c-deep', 'c-top'])
    assert.ok(permissionsChecked.every((permission) => permission === 'manage:pages'))
  } finally {
    stub.restore()
  }
})

test('PURGE EMPTY FOLDERS route: a folder whose empty child the caller cannot manage is left alone', async () => {
  const stub = stubPurge(NESTED_CANDIDATES)
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => page.path !== 'a/b'
  try {
    const res = await app.inject({
      method: 'POST',
      url: PURGE_URL,
      headers: { 'x-test-session': SIGNED_IN },
      payload: { dryRun: false }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(stub.deleted, ['c-other'])
    assert.deepEqual(
      res.json().folders.map((f: any) => f.id),
      ['c-other']
    )
  } finally {
    stub.restore()
  }
})

test('PURGE EMPTY FOLDERS route: a same-named folder in another locale does not stand in for the caller’s own', async () => {
  const stub = stubPurge([
    { id: 'fr-child', path: 'a/b', locale: 'fr' },
    { id: 'en-top', path: 'a', locale: 'en' }
  ])
  ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => page.locale === 'en'
  try {
    const res = await app.inject({
      method: 'POST',
      url: PURGE_URL,
      headers: { 'x-test-session': SIGNED_IN },
      payload: { dryRun: false }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(stub.deleted, ['en-top'])
  } finally {
    stub.restore()
  }
})

test('PURGE EMPTY FOLDERS route: a folder that gained a page since it was listed is skipped, not cascaded', async () => {
  const stub = stubPurge(NESTED_CANDIDATES)
  ;(globalThis as any).CARDINAL.models.tree.listDescendants = async (folderId: string) => ({
    pages: ['c-deep', 'c-top'].includes(folderId)
      ? [{ id: 'p', path: 'a/b/new', locale: 'en', tags: [], classification: null }]
      : [],
    assets: []
  })
  try {
    const res = await app.inject({
      method: 'POST',
      url: PURGE_URL,
      headers: { 'x-test-session': SIGNED_IN },
      payload: { dryRun: false }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(stub.deleted, ['c-other'])
    assert.equal(res.json().count, 1)
  } finally {
    stub.restore()
  }
})
