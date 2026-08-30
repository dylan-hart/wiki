import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
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
        createFolder: async (input: any) => ({
          id: 'new-folder-id',
          siteId: input.siteId,
          fileName: input.pathName,
          folderPath: input.parentPath ?? '',
          locale: input.locale,
          meta: {}
        }),
        getTree: async () => []
      },
      groups: {
        actorForRequest: () => ({ permissions: [] })
      }
    }
  }

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
  await app.register(fastifySensible)
  // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/etc. is a thrown
  //    `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that shapes it
  //    into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
  app.setErrorHandler((error: any, req, reply) => {
    reply.code(error.statusCode ?? 500).send({
      ok: false,
      error: error.name,
      statusCode: error.statusCode ?? 500,
      message: error.message
    })
  })
  // -> Stands in for the real session plugin (`@fastify/session`, wired in `index.ts`): a request
  //    carrying this header gets an authenticated `req.session`, exactly the shape
  //    `!req.session?.authenticated` in BROWSE THE TREE's handler reads.
  app.addHook('onRequest', (req, _reply, done) => {
    ;(req as any).session =
      req.headers['x-test-authenticated'] === 'true' ? { authenticated: true } : undefined
    done()
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
 * OpenProject #1587 §2 / task 1599: BROWSE THE TREE threads `publicOnly: !req.session?.authenticated`
 * through to `getTree`, so an anonymous request applies the same publication-state filter
 * `tree.browse()`/`tree.listPages()` already apply, closing the gap `visibleTreeItems`'s own filter
 * (a page-rule PERMISSION check, not publication state) never covered.
 */
test('GET TREE route: an unauthenticated request passes publicOnly: true', async () => {
  let getTreePublicOnly: boolean | undefined = undefined
  ;(globalThis as any).WIKI.models.tree.getTree = async (args: any) => {
    getTreePublicOnly = args.publicOnly
    return []
  }
  const res = await app.inject({ method: 'GET', url: `/sites/${ENABLED_SITE_ID}/tree` })
  assert.equal(res.statusCode, 200)
  assert.equal(getTreePublicOnly, true)
})

test('GET TREE route: an authenticated session passes publicOnly: false', async () => {
  let getTreePublicOnly: boolean | undefined = undefined
  ;(globalThis as any).WIKI.models.tree.getTree = async (args: any) => {
    getTreePublicOnly = args.publicOnly
    return []
  }
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${ENABLED_SITE_ID}/tree`,
    headers: { 'x-test-authenticated': 'true' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(getTreePublicOnly, false)
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
 * OpenProject #2093: both the folder DELETE and PATCH (rename) handlers used to authorize only the
 * folder's own path and then act on every descendant unchecked. These lock down the fix: every
 * descendant page/asset is now checked (via `listDescendants()`) before either cascade is allowed
 * to run, all-or-nothing.
 *
 * A separate app/WIKI stub from the describe-less tests above, since the DELETE route requires a
 * real session (`actorFrom()`) neither of those needed.
 */
describe('folder DELETE/PATCH: per-descendant authorization (OpenProject #2093)', () => {
  const SITE_ID = '33333333-3333-4333-8333-333333333333'
  const OTHER_FOLDER_ID = '77777777-7777-4777-8777-777777777777'

  let descApp: FastifyInstance
  let deleteFolderCalls: any[]
  let deleteOrphanedPagesCalls: any[]
  let deleteOrphanedAssetsCalls: any[]
  let renameFolderCalls: any[]
  let listDescendantsResult: { pages: any[]; assets: any[] }
  let checkAccessResult: boolean | ((permission: string, page: any) => boolean)

  function sessionHeader() {
    return {
      'x-test-session': JSON.stringify({ authenticated: true, user: { id: 'user-1' } })
    }
  }

  before(async () => {
    ;(globalThis as any).WIKI = {
      sites: { [SITE_ID]: { id: SITE_ID, isEnabled: true, config: {} } },
      models: {
        tree: {
          getFolderById: async () => ({
            id: OTHER_FOLDER_ID,
            siteId: SITE_ID,
            fileName: 'branch',
            folderPath: '',
            locale: 'en',
            meta: {}
          }),
          listDescendants: async () => listDescendantsResult,
          deleteFolder: async (...args: any[]) => {
            deleteFolderCalls.push(args)
            return { pages: [], assets: [] }
          },
          renameFolder: async (input: any) => {
            renameFolderCalls.push(input)
            return { ...input, siteId: SITE_ID, folderPath: '', locale: 'en', meta: {} }
          }
        },
        pages: {
          deleteOrphaned: async (...args: any[]) => {
            deleteOrphanedPagesCalls.push(args)
          }
        },
        assets: {
          deleteOrphaned: async (...args: any[]) => {
            deleteOrphanedAssetsCalls.push(args)
          }
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          groupIdsForRequest: () => [],
          checkAccess: (_actor: any, permission: string, page: any) =>
            typeof checkAccessResult === 'function'
              ? checkAccessResult(permission, page)
              : checkAccessResult
        }
      }
    }

    descApp = fastify({ ajv: { plugins: [[ajvFormats.default, {}] as any] } })
    await descApp.register(fastifySensible)
    descApp.addHook('preHandler', (req, _reply, done) => {
      const raw = req.headers['x-test-session']
      if (typeof raw === 'string') {
        ;(req as any).session = JSON.parse(raw)
      }
      done()
    })
    descApp.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerTreeSchema(descApp)
    await registerErrorSchema(descApp)
    await descApp.register(treeRoutes)
    await descApp.ready()
  })

  after(async () => {
    await descApp.close()
    delete (globalThis as any).WIKI
  })

  test('DELETE: nothing is deleted when one descendant page is denied delete:pages', async () => {
    deleteFolderCalls = []
    deleteOrphanedPagesCalls = []
    deleteOrphanedAssetsCalls = []
    listDescendantsResult = {
      pages: [{ path: 'branch/allowed', locale: 'en', tags: [], classification: null }],
      assets: []
    }
    // -> manage:pages (the folder-root check) passes, delete:pages fails for the one descendant page
    checkAccessResult = (permission: string) => permission !== 'delete:pages'

    const res = await descApp.inject({
      method: 'DELETE',
      url: `/sites/${SITE_ID}/tree/folders/${OTHER_FOLDER_ID}`,
      headers: sessionHeader()
    })
    assert.equal(res.statusCode, 403)
    assert.equal(deleteFolderCalls.length, 0)
    assert.equal(deleteOrphanedPagesCalls.length, 0)
    assert.equal(deleteOrphanedAssetsCalls.length, 0)
  })

  test('DELETE: nothing is deleted when one descendant asset is denied manage:assets', async () => {
    deleteFolderCalls = []
    listDescendantsResult = {
      pages: [],
      assets: [{ path: 'branch/logo.png', locale: 'en', tags: [], classification: null }]
    }
    checkAccessResult = (permission: string) => permission !== 'manage:assets'

    const res = await descApp.inject({
      method: 'DELETE',
      url: `/sites/${SITE_ID}/tree/folders/${OTHER_FOLDER_ID}`,
      headers: sessionHeader()
    })
    assert.equal(res.statusCode, 403)
    assert.equal(deleteFolderCalls.length, 0)
  })

  test('DELETE: proceeds and cleans up orphans when every descendant is authorized', async () => {
    deleteFolderCalls = []
    deleteOrphanedPagesCalls = []
    deleteOrphanedAssetsCalls = []
    listDescendantsResult = {
      pages: [{ path: 'branch/allowed', locale: 'en', tags: [], classification: null }],
      assets: [{ path: 'branch/logo.png', locale: 'en', tags: [], classification: null }]
    }
    checkAccessResult = true

    const res = await descApp.inject({
      method: 'DELETE',
      url: `/sites/${SITE_ID}/tree/folders/${OTHER_FOLDER_ID}`,
      headers: sessionHeader()
    })
    assert.equal(res.statusCode, 204)
    assert.equal(deleteFolderCalls.length, 1)
    assert.equal(deleteOrphanedPagesCalls.length, 1)
    assert.equal(deleteOrphanedAssetsCalls.length, 1)
  })

  test('DELETE: an unauthenticated request is refused before any descendant is even listed', async () => {
    deleteFolderCalls = []
    listDescendantsResult = { pages: [], assets: [] }
    checkAccessResult = true

    const res = await descApp.inject({
      method: 'DELETE',
      url: `/sites/${SITE_ID}/tree/folders/${OTHER_FOLDER_ID}`
    })
    assert.equal(res.statusCode, 401)
    assert.equal(deleteFolderCalls.length, 0)
  })

  test('RENAME (title-only, unchanged pathName): skips the destination/descendant checks entirely', async () => {
    renameFolderCalls = []
    let listDescendantsCalled = false
    const originalListDescendants = (globalThis as any).WIKI.models.tree.listDescendants
    ;(globalThis as any).WIKI.models.tree.listDescendants = async () => {
      listDescendantsCalled = true
      return { pages: [], assets: [] }
    }
    checkAccessResult = true
    try {
      const res = await descApp.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/tree/folders/${OTHER_FOLDER_ID}`,
        payload: { pathName: 'branch', title: 'New Title' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(listDescendantsCalled, false)
      assert.equal(renameFolderCalls.length, 1)
    } finally {
      ;(globalThis as any).WIKI.models.tree.listDescendants = originalListDescendants
    }
  })

  test('RENAME (path change): refused when the destination itself is denied write:pages', async () => {
    renameFolderCalls = []
    checkAccessResult = (permission: string) => permission !== 'write:pages'

    const res = await descApp.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/tree/folders/${OTHER_FOLDER_ID}`,
      payload: { pathName: 'renamed', title: 'Renamed' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(renameFolderCalls.length, 0)
  })

  test('RENAME (path change): refused when a descendant page is denied write:pages at its post-rename path', async () => {
    renameFolderCalls = []
    listDescendantsResult = {
      pages: [{ path: 'branch/child', locale: 'en', tags: [], classification: null }],
      assets: []
    }
    // -> manage:pages (both the folder-root check and the descendant's current-path check) and the
    //    destination's own write:pages all pass; only the descendant's POST-rename write:pages fails
    checkAccessResult = (permission: string, page: any) =>
      !(permission === 'write:pages' && page.path === 'renamed/child')

    const res = await descApp.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/tree/folders/${OTHER_FOLDER_ID}`,
      payload: { pathName: 'renamed', title: 'Renamed' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(renameFolderCalls.length, 0)
  })

  test('RENAME (path change): proceeds when the destination and every descendant are authorized', async () => {
    renameFolderCalls = []
    listDescendantsResult = {
      pages: [{ path: 'branch/child', locale: 'en', tags: [], classification: null }],
      assets: []
    }
    checkAccessResult = true

    const res = await descApp.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/tree/folders/${OTHER_FOLDER_ID}`,
      payload: { pathName: 'renamed', title: 'Renamed' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(renameFolderCalls.length, 1)
  })
})
