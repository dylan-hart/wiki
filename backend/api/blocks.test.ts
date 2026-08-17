import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import blocksRoutes from './blocks.ts'
import { registerSchemas as registerBlockSchema } from './schemas/block.ts'

/**
 * Task #683: `PUT`/`DELETE /sites/:siteId/blocks(/:blockId)` used to gate on the blanket route-level
 * `manage:sites` alone. Both routes now also accept the site-scoped `site:blocks` permission from
 * task #682 (`checkSiteAccess()`), checked in-handler via `mayManageBlocks` since `config.permissions`
 * cannot express a per-site check (same reasoning as page permissions — see CLAUDE.md).
 */

const SITE_ID = '5d9c8f1e-2b3a-4c5d-9e6f-7a8b9c0d1e2f'
const BLOCK_ID = 'a1b2c3d4-e5f6-4789-9abc-def012345678'

const sites: Record<string, any> = { [SITE_ID]: { id: SITE_ID } }
async function getSiteById({ id }: { id: string }) {
  return sites[id] ?? null
}

let setBlocksStateCalls: Array<{ siteId: string; states: any }> = []
let deleteCustomBlockCalls: Array<{ siteId: string; blockId: string }> = []

const siteBlocks = [
  { id: BLOCK_ID, block: 'custom-thing', isCustom: true },
  { id: 'built-in-block-id', block: 'gallery', isCustom: false }
]

async function getSiteBlocks() {
  return siteBlocks
}
async function setBlocksState(siteId: string, states: any) {
  setBlocksStateCalls.push({ siteId, states })
  return states.length
}
async function deleteCustomBlock(siteId: string, blockId: string) {
  deleteCustomBlockCalls.push({ siteId, blockId })
}

/**
 * Stand-in for `checkSiteAccess()`: grants `site:blocks` only for the site id the
 * `x-test-site-permissions` header names, so a grant for a different site does nothing here.
 */
let currentSitePermissionHeader: string | undefined
function checkSiteAccess(actor: { permissions: string[] }, permission: string, siteId: string) {
  if (actor.permissions.includes('manage:system')) {
    return true
  }
  return typeof currentSitePermissionHeader === 'string'
    ? currentSitePermissionHeader.split(',').filter(Boolean).includes(`${permission}@${siteId}`)
    : false
}

function actorForRequest(req: any) {
  const header = req.headers['x-test-permissions']
  const permissions = typeof header === 'string' ? header.split(',').filter(Boolean) : []
  return { groupIds: [], permissions }
}

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      sites: { getSiteById },
      blocks: { getSiteBlocks, setBlocksState, deleteCustomBlock },
      groups: { actorForRequest, checkSiteAccess },
      approvals: {
        getActorGroupIds: () => [],
        getRules: async () => []
      }
    },
    logger: { warn: () => {} }
  }

  app = fastify()
  await app.register(fastifySensible)
  await registerBlockSchema(app)
  app.addHook('preHandler', (req: any, reply, done) => {
    currentSitePermissionHeader = req.headers['x-test-site-permissions']
    done()
  })
  await app.register(blocksRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  setBlocksStateCalls = []
  deleteCustomBlockCalls = []
})

test('manage:sites may set blocks state', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/blocks`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { states: [{ id: BLOCK_ID, isEnabled: false }] }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(setBlocksStateCalls.length, 1)
})

test('site:blocks on this site may set blocks state', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/blocks`,
    headers: { 'x-test-site-permissions': `site:blocks@${SITE_ID}` },
    payload: { states: [{ id: BLOCK_ID, isEnabled: false }] }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(setBlocksStateCalls.length, 1)
})

test('site:blocks on a DIFFERENT site does not grant access to this site', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/blocks`,
    headers: { 'x-test-site-permissions': 'site:blocks@some-other-site' },
    payload: { states: [{ id: BLOCK_ID, isEnabled: false }] }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(setBlocksStateCalls.length, 0)
})

test('a caller with neither manage:sites nor site:blocks is refused', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/blocks`,
    headers: { 'x-test-permissions': 'manage:navigation' },
    payload: { states: [{ id: BLOCK_ID, isEnabled: false }] }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(setBlocksStateCalls.length, 0)
})

test('site:blocks on this site may delete a custom block', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: `/sites/${SITE_ID}/blocks/${BLOCK_ID}`,
    headers: { 'x-test-site-permissions': `site:blocks@${SITE_ID}` }
  })
  assert.equal(res.statusCode, 204)
  assert.equal(deleteCustomBlockCalls.length, 1)
})

test('site:blocks on a DIFFERENT site may not delete a custom block here', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: `/sites/${SITE_ID}/blocks/${BLOCK_ID}`,
    headers: { 'x-test-site-permissions': 'site:blocks@some-other-site' }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(deleteCustomBlockCalls.length, 0)
})
