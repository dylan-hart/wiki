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

const DUPLICATE_DEST_ID = '66666666-6666-4666-8666-666666666666'
const DUPLICATE_SESSION = JSON.stringify({ authenticated: true, user: { id: 'user-1' } })

interface DuplicateScenario {
  folders?: Record<string, any>
  existingFolders?: string[]
  pages?: any[]
  assets?: any[]
  allow?: (permission: string, ref: any) => boolean
  lockedPages?: string[]
  duplicate?: (args: any) => any
}

async function withDuplicateMocks(
  scenario: DuplicateScenario,
  fn: (calls: { access: any[]; duplicate: any[]; getPage: any[] }) => Promise<void>
) {
  const models = (globalThis as any).CARDINAL.models
  const saved = {
    tree: { ...models.tree },
    groups: { ...models.groups },
    pages: { ...models.pages }
  }
  const calls = { access: [] as any[], duplicate: [] as any[], getPage: [] as any[] }
  const folders: Record<string, any> = {
    [FOLDER_ID]: {
      id: FOLDER_ID,
      siteId: ENABLED_SITE_ID,
      fileName: 'sub',
      folderPath: '',
      locale: 'en',
      meta: {}
    },
    ...scenario.folders
  }
  models.tree.getFolderById = async (id: string) => folders[id] ?? null
  models.tree.getFolder = async ({ path }: { path: string }) => {
    if (scenario.existingFolders?.includes(path)) {
      return { id: path }
    }
    throw new CustomError('treeInvalidFolder', 'This folder does not exist.', 404)
  }
  models.tree.listDescendants = async () => ({
    pages: scenario.pages ?? [],
    assets: scenario.assets ?? []
  })
  models.tree.duplicateFolder =
    scenario.duplicate ??
    (async (args: any) => {
      calls.duplicate.push(args)
      return {
        folder: {
          id: DUPLICATE_DEST_ID,
          fileName: args.pathName ?? 'sub',
          folderPath: args.parentPath ?? '',
          locale: 'en',
          meta: { children: 2 }
        },
        folders: 2,
        pages: scenario.pages?.length ?? 0,
        assets: scenario.assets?.length ?? 0
      }
    })
  models.groups.checkAccess = (_actor: any, permission: string, ref: any) => {
    calls.access.push({ permission, ref })
    return scenario.allow ? scenario.allow(permission, ref) : true
  }
  models.pages.getPage = async (args: any) => {
    calls.getPage.push(args)
    return { id: args.id, isLocked: scenario.lockedPages?.includes(args.id) ?? false }
  }
  try {
    await fn(calls)
  } finally {
    Object.assign(models.tree, saved.tree)
    Object.assign(models.groups, saved.groups)
    Object.assign(models.pages, saved.pages)
  }
}

function duplicate(payload: Record<string, any>, session: string | null = DUPLICATE_SESSION) {
  return app.inject({
    method: 'POST',
    url: `/sites/${ENABLED_SITE_ID}/tree/folders/${FOLDER_ID}/duplicate`,
    headers: session ? { 'x-test-session': session } : {},
    payload
  })
}

const DUP_PAGE_A = {
  id: 'page-a',
  path: 'sub/a',
  locale: 'en',
  tags: ['x'],
  classification: 'internal'
}
const DUP_PAGE_B = {
  id: 'page-b',
  path: 'sub/deep/b',
  locale: 'en',
  tags: [],
  classification: null
}
const DUP_ASSET = {
  id: 'asset-a',
  path: 'sub/deep/pic.png',
  folderPath: 'sub/deep',
  fileName: 'pic.png',
  locale: 'en'
}

test('DUPLICATE FOLDER route: an authorized request makes exactly one model call and returns its result', async () => {
  await withDuplicateMocks(
    { pages: [DUP_PAGE_A, DUP_PAGE_B], assets: [DUP_ASSET] },
    async (calls) => {
      const res = await duplicate({ parentPath: 'other', pathName: 'sub-copy', title: 'Sub copy' })
      assert.equal(res.statusCode, 200)
      assert.equal(calls.duplicate.length, 1)
      assert.equal(calls.duplicate[0].id, FOLDER_ID)
      assert.equal(calls.duplicate[0].siteId, ENABLED_SITE_ID)
      assert.equal(calls.duplicate[0].parentPath, 'other')
      assert.equal(calls.duplicate[0].folderId, undefined)
      assert.equal(calls.duplicate[0].pathName, 'sub-copy')
      assert.equal(calls.duplicate[0].title, 'Sub copy')
      assert.equal(calls.duplicate[0].actor.id, 'user-1')
      const body = res.json()
      assert.equal(body.ok, true)
      assert.equal(body.folder.id, DUPLICATE_DEST_ID)
      assert.equal(body.folder.childrenCount, 2)
      assert.equal(body.folders, 2)
      assert.equal(body.pages, 2)
      assert.equal(body.assets, 1)
    }
  )
})

test('DUPLICATE FOLDER route: judges every source read and every destination write on the path each copy lands at', async () => {
  await withDuplicateMocks(
    { pages: [DUP_PAGE_A, DUP_PAGE_B], assets: [DUP_ASSET] },
    async (calls) => {
      const res = await duplicate({ parentPath: 'other', pathName: 'sub-copy' })
      assert.equal(res.statusCode, 200)
      const asked = calls.access.map((entry) => `${entry.permission} ${entry.ref.path}`)
      assert.ok(asked.includes('read:pages sub'))
      assert.ok(asked.includes('manage:pages other/sub-copy'))
      assert.ok(asked.includes('read:pages sub/a'))
      assert.ok(asked.includes('write:pages other/sub-copy/a'))
      assert.ok(asked.includes('write:pages other/sub-copy/deep/b'))
      assert.ok(asked.includes('read:assets sub/deep/pic.png'))
      assert.ok(asked.includes('write:assets other/sub-copy/deep/pic.png'))
      const write = calls.access.find(
        (entry) => entry.permission === 'write:pages' && entry.ref.path === 'other/sub-copy/a'
      )
      assert.deepEqual(write.ref.tags, ['x'])
      assert.equal(write.ref.classification, 'internal')
    }
  )
})

test('DUPLICATE FOLDER route: refuses an anonymous request and copies nothing', async () => {
  await withDuplicateMocks({}, async (calls) => {
    const res = await duplicate({}, null)
    assert.equal(res.statusCode, 401)
    assert.equal(calls.duplicate.length, 0)
  })
})

test('DUPLICATE FOLDER route: a source the caller cannot read answers 404', async () => {
  await withDuplicateMocks(
    { allow: (permission) => permission !== 'read:pages' },
    async (calls) => {
      const res = await duplicate({ pathName: 'x' })
      assert.equal(res.statusCode, 404)
      assert.equal(calls.duplicate.length, 0)
    }
  )
})

test('DUPLICATE FOLDER route: one page the caller cannot read refuses the whole request', async () => {
  await withDuplicateMocks(
    {
      pages: [DUP_PAGE_A, DUP_PAGE_B],
      allow: (permission, ref) => !(permission === 'read:pages' && ref.path === 'sub/deep/b')
    },
    async (calls) => {
      const res = await duplicate({ pathName: 'sub-copy' })
      assert.equal(res.statusCode, 403)
      assert.match(res.json().message, /sub\/deep\/b/)
      assert.equal(calls.duplicate.length, 0)
    }
  )
})

test('DUPLICATE FOLDER route: one page the caller cannot write at its destination refuses the whole request', async () => {
  await withDuplicateMocks(
    {
      pages: [DUP_PAGE_A, DUP_PAGE_B],
      allow: (permission, ref) =>
        !(permission === 'write:pages' && ref.path === 'other/sub-copy/deep/b')
    },
    async (calls) => {
      const res = await duplicate({ parentPath: 'other', pathName: 'sub-copy' })
      assert.equal(res.statusCode, 403)
      assert.match(res.json().message, /other\/sub-copy\/deep\/b/)
      assert.equal(calls.duplicate.length, 0)
    }
  )
})

test('DUPLICATE FOLDER route: one asset the caller cannot read refuses the whole request', async () => {
  await withDuplicateMocks(
    {
      pages: [DUP_PAGE_A],
      assets: [DUP_ASSET],
      allow: (permission) => permission !== 'read:assets'
    },
    async (calls) => {
      const res = await duplicate({ pathName: 'sub-copy' })
      assert.equal(res.statusCode, 403)
      assert.equal(calls.duplicate.length, 0)
    }
  )
})

test('DUPLICATE FOLDER route: one asset the caller cannot write at its destination refuses the whole request', async () => {
  await withDuplicateMocks(
    {
      pages: [DUP_PAGE_A],
      assets: [DUP_ASSET],
      allow: (permission) => permission !== 'write:assets'
    },
    async (calls) => {
      const res = await duplicate({ pathName: 'sub-copy' })
      assert.equal(res.statusCode, 403)
      assert.match(res.json().message, /sub-copy\/deep\/pic\.png/)
      assert.equal(calls.duplicate.length, 0)
    }
  )
})

test('DUPLICATE FOLDER route: refuses when the caller cannot manage the copy’s own path', async () => {
  await withDuplicateMocks(
    { allow: (permission, ref) => !(permission === 'manage:pages' && ref.path === 'sub-copy') },
    async (calls) => {
      const res = await duplicate({ pathName: 'sub-copy' })
      assert.equal(res.statusCode, 403)
      assert.equal(calls.duplicate.length, 0)
    }
  )
})

test('DUPLICATE FOLDER route: a missing destination ancestor the caller may not create refuses the request', async () => {
  await withDuplicateMocks(
    {
      existingFolders: ['area'],
      allow: (permission, ref) => !(permission === 'manage:pages' && ref.path === 'area/new')
    },
    async (calls) => {
      const res = await duplicate({ parentPath: 'area/new/deeper', pathName: 'sub-copy' })
      assert.equal(res.statusCode, 403)
      assert.match(res.json().message, /area\/new/)
      assert.equal(calls.duplicate.length, 0)
    }
  )
})

test('DUPLICATE FOLDER route: an existing destination ancestor needs no create permission of its own', async () => {
  await withDuplicateMocks(
    {
      existingFolders: ['area', 'area/new'],
      allow: (permission, ref) => !(permission === 'manage:pages' && ref.path === 'area/new')
    },
    async (calls) => {
      const res = await duplicate({ parentPath: 'area/new', pathName: 'sub-copy' })
      assert.equal(res.statusCode, 200)
      assert.equal(calls.duplicate.length, 1)
    }
  )
})

test('DUPLICATE FOLDER route: a destination folderId is resolved for its path and locale', async () => {
  await withDuplicateMocks(
    {
      folders: {
        [DUPLICATE_DEST_ID]: {
          id: DUPLICATE_DEST_ID,
          fileName: 'dest',
          folderPath: 'top',
          locale: 'fr'
        }
      },
      pages: [DUP_PAGE_A]
    },
    async (calls) => {
      const res = await duplicate({ folderId: DUPLICATE_DEST_ID, parentPath: 'ignored' })
      assert.equal(res.statusCode, 200)
      assert.equal(calls.duplicate[0].folderId, DUPLICATE_DEST_ID)
      assert.equal(calls.duplicate[0].parentPath, undefined)
      const write = calls.access.find(
        (entry) => entry.permission === 'write:pages' && entry.ref.locale === 'fr'
      )
      assert.equal(write.ref.path, 'top/dest/sub/a')
      assert.equal(write.ref.locale, 'fr')
    }
  )
})

test('DUPLICATE FOLDER route: a destination folderId that does not resolve in this site answers 404', async () => {
  await withDuplicateMocks({}, async (calls) => {
    const res = await duplicate({ folderId: DUPLICATE_DEST_ID })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().message, 'The destination folder does not exist.')
    assert.equal(calls.duplicate.length, 0)
  })
})

test('DUPLICATE FOLDER route: refuses a copy into the folder itself', async () => {
  await withDuplicateMocks({}, async (calls) => {
    const res = await duplicate({ parentPath: 'sub', pathName: 'sub-copy' })
    assert.equal(res.statusCode, 400)
    assert.equal(calls.duplicate.length, 0)
  })
})

test('DUPLICATE FOLDER route: refuses a copy into a folder inside it, by path or by id', async () => {
  await withDuplicateMocks(
    {
      folders: {
        [DUPLICATE_DEST_ID]: {
          id: DUPLICATE_DEST_ID,
          fileName: 'deep',
          folderPath: 'sub',
          locale: 'en'
        }
      }
    },
    async (calls) => {
      const byPath = await duplicate({ parentPath: 'Sub/Deep/Deeper', pathName: 'sub-copy' })
      assert.equal(byPath.statusCode, 400)
      const byId = await duplicate({ folderId: DUPLICATE_DEST_ID, pathName: 'sub-copy' })
      assert.equal(byId.statusCode, 400)
      assert.equal(calls.duplicate.length, 0)
    }
  )
})

test('DUPLICATE FOLDER route: a sibling whose name merely starts with the source’s name is not inside it', async () => {
  await withDuplicateMocks({ existingFolders: ['sub-two'] }, async (calls) => {
    const res = await duplicate({ parentPath: 'sub-two' })
    assert.equal(res.statusCode, 200)
    assert.equal(calls.duplicate.length, 1)
  })
})

test('DUPLICATE FOLDER route: the same path in another locale is not inside the source', async () => {
  await withDuplicateMocks(
    {
      folders: {
        [DUPLICATE_DEST_ID]: {
          id: DUPLICATE_DEST_ID,
          fileName: 'sub',
          folderPath: '',
          locale: 'fr'
        }
      }
    },
    async (calls) => {
      const res = await duplicate({ folderId: DUPLICATE_DEST_ID })
      assert.equal(res.statusCode, 200)
      assert.equal(calls.duplicate.length, 1)
    }
  )
})

const NO_SOURCE_BYPASS = (permission: string, ref: any) =>
  permission === 'read:pages' || String(ref.path).startsWith('other')

test('DUPLICATE FOLDER route: a password-protected page the caller has not unlocked refuses the whole request', async () => {
  await withDuplicateMocks(
    { pages: [DUP_PAGE_A, DUP_PAGE_B], lockedPages: ['page-b'], allow: NO_SOURCE_BYPASS },
    async (calls) => {
      const res = await duplicate({ parentPath: 'other', pathName: 'sub-copy' })
      assert.equal(res.statusCode, 403)
      assert.match(res.json().message, /password protected/)
      assert.equal(calls.duplicate.length, 0)
    }
  )
})

test('DUPLICATE FOLDER route: an unlocked page without a password copies as normal', async () => {
  await withDuplicateMocks({ pages: [DUP_PAGE_A], allow: NO_SOURCE_BYPASS }, async (calls) => {
    const res = await duplicate({ parentPath: 'other', pathName: 'sub-copy' })
    assert.equal(res.statusCode, 200)
    assert.equal(calls.getPage.length, 1)
    assert.equal(calls.duplicate.length, 1)
  })
})

test('DUPLICATE FOLDER route: a caller who may write the locked page needs no password, as everywhere else', async () => {
  await withDuplicateMocks({ pages: [DUP_PAGE_A], lockedPages: ['page-a'] }, async (calls) => {
    const res = await duplicate({ parentPath: 'other', pathName: 'sub-copy' })
    assert.equal(res.statusCode, 200)
    assert.equal(calls.getPage.length, 0)
    assert.equal(calls.duplicate.length, 1)
  })
})

test('DUPLICATE FOLDER route: a name collision from the model answers 409', async () => {
  await withDuplicateMocks(
    {
      duplicate: async () => {
        throw new CustomError('treeFolderDuplicate', 'A folder with that name exists.', 409)
      }
    },
    async () => {
      const res = await duplicate({ parentPath: '' })
      assert.equal(res.statusCode, 409)
    }
  )
})

test('DUPLICATE FOLDER route: rejects a pathName that is not a valid segment', async () => {
  await withDuplicateMocks({}, async (calls) => {
    const res = await duplicate({ pathName: 'Not Valid' })
    assert.equal(res.statusCode, 400)
    assert.equal(calls.duplicate.length, 0)
  })
})
