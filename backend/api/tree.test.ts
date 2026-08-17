import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import treeRoutes, { mayOnFolder, visibleTreeItems } from './tree.ts'
import { registerSchemas as registerTreeSchema } from './schemas/tree.ts'

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
          meta: {}
        }),
        renameFolder: async (input: any) => ({
          ...input,
          siteId: ENABLED_SITE_ID,
          folderPath: '',
          meta: {}
        })
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
  await registerTreeSchema(app)
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
    { type: 'page', fileName: 'a', folderPath: '' },
    { type: 'asset', fileName: 'b.png', folderPath: 'folder' }
  ]
  const result = visibleTreeItems({} as any, ENABLED_SITE_ID, items)
  assert.equal(result.length, 2)
  assert.equal(calls.length, 2)
  for (const page of calls) {
    assert.equal(page.siteId, ENABLED_SITE_ID)
  }
  assert.equal(calls[0].path, 'a')
  assert.equal(calls[1].path, 'folder/b.png')
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
  const result = mayOnFolder({} as any, 'read:pages', ENABLED_SITE_ID, 'foo/bar')
  assert.equal(result, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].siteId, ENABLED_SITE_ID)
  assert.equal(calls[0].path, 'foo/bar')
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
