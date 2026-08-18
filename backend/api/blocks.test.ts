import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import blocksRoutes from './blocks.ts'
import { registerSchemas as registerBlockSchema } from './schemas/block.ts'

describe('POST /sites/:siteId/blocks (custom block upload)', () => {
  /**
   * `POST /sites/:siteId/blocks` — a unit-level test of the route's own wiring (site lookup, raw-body
   * handling, validator plumbing, tag-collision check, response shape), the same way `sites.test.ts`
   * covers `GET /:siteIdorHostname` without a real database: `WIKI.models.sites`/`blocks` are stubbed
   * rather than pulling in Drizzle. `models/blocks.test.ts` is what proves `isTagTaken()` and
   * `createCustomBlock()` themselves against a real database.
   *
   * The route declares `config: { permissions: ['manage:sites'] }` (`api/blocks.ts`) — enforced by the
   * global `preHandler` hook in `index.ts`, which this plugin-only app never registers, exactly as
   * `sites.test.ts` also does not exercise it. Not this suite's job to re-prove.
   */
  const SITE_ID = '11111111-1111-1111-1111-111111111111'

  const WELL_FORMED = `
export class BlockWidget extends HTMLElement {
  static definition = {
    block: 'widget',
    name: 'Widget',
    description: 'A test widget.',
    icon: 'mdi:cube',
    props: [{ name: 'title', type: 'string' }],
    template: 'Starter body'
  }
}
customElements.define('block-widget', BlockWidget)
`

  let app: FastifyInstance
  let createCustomBlockCalls: { siteId: string; definition: any; code: Buffer }[]
  let isTagTakenResult = false

  before(async () => {
    ;(globalThis as any).WIKI = {
      config: { security: { uploadMaxFileSize: 10485760 } },
      models: {
        sites: {
          getSiteById: async ({ id }: { id: string }) => (id === SITE_ID ? { id } : null)
        },
        blocks: {
          isTagTaken: async () => isTagTakenResult,
          createCustomBlock: async (siteId: string, definition: any, code: Buffer) => {
            createCustomBlockCalls.push({ siteId, definition, code })
            return {
              id: 'new-block-id',
              block: definition.block,
              name: definition.name,
              description: definition.description,
              icon: definition.icon,
              isEnabled: true,
              isCustom: true,
              config: {},
              props: definition.props ?? [],
              template: definition.template ?? '',
              elementTag: `block-${definition.block}`
            }
          }
        }
      }
    }

    app = fastify()
    await app.register(fastifySensible)
    await registerBlockSchema(app)
    await app.register(blocksRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    createCustomBlockCalls = []
    isTagTakenResult = false
  })

  test('404s when the site does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sites/00000000-0000-0000-0000-000000000000/blocks',
      payload: Buffer.from(WELL_FORMED),
      headers: { 'content-type': 'text/javascript' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('400s on an empty body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/blocks`,
      payload: Buffer.alloc(0),
      headers: { 'content-type': 'text/javascript' }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(createCustomBlockCalls.length, 0)
  })

  test('400s with a specific message when the source has no static definition', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/blocks`,
      payload: Buffer.from('export class BlockWidget extends HTMLElement {}'),
      headers: { 'content-type': 'text/javascript' }
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /static definition/)
    assert.equal(createCustomBlockCalls.length, 0)
  })

  test('400s with a specific message on unparseable JavaScript', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/blocks`,
      payload: Buffer.from('this is not valid javascript {{{'),
      headers: { 'content-type': 'text/javascript' }
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /could not parse/)
    assert.equal(createCustomBlockCalls.length, 0)
  })

  test('409s when the tag is already taken, without registering the block', async () => {
    isTagTakenResult = true
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/blocks`,
      payload: Buffer.from(WELL_FORMED),
      headers: { 'content-type': 'text/javascript' }
    })
    assert.equal(res.statusCode, 409)
    assert.match(res.json().message, /widget/)
    assert.equal(createCustomBlockCalls.length, 0)
  })

  test('registers the block and returns the created SiteBlock on success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/blocks`,
      payload: Buffer.from(WELL_FORMED),
      headers: { 'content-type': 'text/javascript' }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.block.block, 'widget')
    assert.equal(body.block.isCustom, true)
    assert.equal(body.block.isEnabled, true)
    assert.equal(body.block.elementTag, 'block-widget')
    assert.deepEqual(body.block.props, [{ name: 'title', type: 'string' }])

    assert.equal(createCustomBlockCalls.length, 1)
    assert.equal(createCustomBlockCalls[0]!.siteId, SITE_ID)
    assert.equal(createCustomBlockCalls[0]!.definition.block, 'widget')
    assert.equal(createCustomBlockCalls[0]!.code.toString('utf8'), WELL_FORMED)
  })

  /**
   * The upload size cap (task 660): `addContentTypeParser`'s `bodyLimit` is read from
   * `WIKI.config.security.uploadMaxFileSize` once, at plugin-registration time, exactly like
   * `assets.ts`'s own upload route reuses the same key. A separate app instance is registered here with
   * a tiny configured limit so the test can prove the cap is actually wired up and enforced — rather
   * than only asserting the source line reads the config key — without allocating a real multi-megabyte
   * buffer.
   */
  test('rejects a payload larger than the configured upload size cap with 413', async () => {
    ;(globalThis as any).WIKI.config.security.uploadMaxFileSize = 16
    const smallApp = fastify()
    await smallApp.register(fastifySensible)
    await registerBlockSchema(smallApp)
    await smallApp.register(blocksRoutes)
    await smallApp.ready()
    try {
      const res = await smallApp.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/blocks`,
        payload: Buffer.from(WELL_FORMED), // well over the 16-byte cap configured above
        headers: { 'content-type': 'text/javascript' }
      })
      assert.equal(res.statusCode, 413)
      assert.equal(createCustomBlockCalls.length, 0)
    } finally {
      await smallApp.close()
      ;(globalThis as any).WIKI.config.security.uploadMaxFileSize = 10485760
    }
  })
})

describe('PUT/DELETE /sites/:siteId/blocks (site-scoped delegation)', () => {
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
      config: { security: { uploadMaxFileSize: 10485760 } },
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
})
