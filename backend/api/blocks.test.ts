import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import { createSiteAdminAccessStub } from '../test/mocks.ts'
import blocksRoutes from './blocks.ts'
import { installTestWiki } from '../test/mocks.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

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
    // -> The unknown-site 404 lives in one hook now (spec D1), not in each route handler, so a
    //    plugin-only app has to register it to answer that case the way the real app does.
    const guardedRoutes: FastifyPluginAsync = async (instance) => {
      instance.addHook('preHandler', siteEnabledPreHandler)
      await instance.register(blocksRoutes)
    }

    app = await buildTestApp({
      routes: guardedRoutes,
      wiki: {
        config: { security: { uploadMaxFileSize: 10485760 } },
        sites: { [SITE_ID]: { id: SITE_ID } },
        models: {
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
    })
  })

  after(() => closeTestApp(app))

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

  /*
    OpenProject #967: the `block` in the definition is a promise about the element the code will
    actually register (`<block-{block}>`) — nothing before this check confirmed the uploaded source
    kept that promise, so a mismatched define() call was accepted and rendered nothing on every page
    using it.
  */
  test('400s with a specific message when define() registers a tag other than block-{block}', async () => {
    const mismatched = `
export class BlockWidget extends HTMLElement {
  static definition = {
    block: 'widget',
    name: 'Widget',
    description: 'A test widget.',
    icon: 'mdi:cube'
  }
}
customElements.define('block-something-else', BlockWidget)
`
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/blocks`,
      payload: Buffer.from(mismatched),
      headers: { 'content-type': 'text/javascript' }
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /block-something-else/)
    assert.match(res.json().message, /block-widget/)
    assert.equal(createCustomBlockCalls.length, 0)
  })

  test('400s with a specific message when the source never calls customElements.define() at all', async () => {
    const noDefine = `
export class BlockWidget extends HTMLElement {
  static definition = {
    block: 'widget',
    name: 'Widget',
    description: 'A test widget.',
    icon: 'mdi:cube'
  }
}
`
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/blocks`,
      payload: Buffer.from(noDefine),
      headers: { 'content-type': 'text/javascript' }
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /customElements\.define/)
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
    WIKI.config.security.uploadMaxFileSize = 16
    // -> No `wiki`: this app has to be built against the SAME global the enclosing describe
    //    installed, with only the cap above changed.
    const smallApp = await buildTestApp({ routes: blocksRoutes })
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
      await closeTestApp(smallApp)
      WIKI.config.security.uploadMaxFileSize = 10485760
    }
  })
})

describe('PUT/DELETE /sites/:siteId/blocks (site-scoped delegation)', () => {
  /**
   * Task #683: `PUT`/`DELETE /sites/:siteId/blocks(/:blockId)` used to gate on the blanket route-level
   * `manage:sites` alone. Both routes now also accept the site-scoped `site:blocks` permission from
   * task #682 (`checkSiteAccess()`), checked in-handler via `checkSiteAdminAccess` since
   * `config.permissions`
   * cannot express a per-site check (same reasoning as page permissions — see CLAUDE.md).
   *
   * OpenProject #2128 settled the question this raised for `docs/security/custom-block-upload.md`:
   * `BLOCK_ID` below is deliberately `isCustom: true` in `siteBlocks` (as opposed to
   * `'built-in-block-id'`, `isCustom: false`, also in the fixture) precisely so
   * "`site:blocks` may set blocks state" / "may delete a custom block" pin the chosen resolution — accept
   * the widening — against the row that actually matters for the "who can make arbitrary script run"
   * question, not incidentally against whichever row happened to be first in the fixture. See that
   * document's §2 for the reconciled permission table and residual-risk statement.
   */
  const SITE_ID = '5d9c8f1e-2b3a-4c5d-9e6f-7a8b9c0d1e2f'
  const BLOCK_ID = 'a1b2c3d4-e5f6-4789-9abc-def012345678'

  const sites: Record<string, any> = { [SITE_ID]: { id: SITE_ID } }

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

  const checkSiteAdminAccess = createSiteAdminAccessStub(actorForRequest, checkSiteAccess)

  let app: FastifyInstance

  before(async () => {
    // -> See the upload describe above: the unknown-site 404 is this hook's job now (spec D1).
    const guardedRoutes: FastifyPluginAsync = async (instance) => {
      instance.addHook('preHandler', siteEnabledPreHandler)
      await instance.register(blocksRoutes)
    }

    app = await buildTestApp({
      routes: guardedRoutes,
      // -> The site-permission stub takes no `req`, so it reads this suite's per-test grants off a
      //    module-level variable, populated once per request.
      session: (req: any) => {
        currentSitePermissionHeader = req.headers['x-test-site-permissions']
        return undefined
      },
      wiki: {
        sites,
        models: {
          blocks: { getSiteBlocks, setBlocksState, deleteCustomBlock },
          groups: { actorForRequest, checkSiteAccess, checkSiteAdminAccess },
          approvals: {
            getActorGroupIds: () => [],
            getRules: async () => []
          }
        },
        config: { security: { uploadMaxFileSize: 10485760 } }
      }
    })
  })

  after(() => closeTestApp(app))

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

  test('site:blocks on this site may enable/disable an isCustom: true block (OpenProject #2128: chosen resolution is to allow this, not incidental)', async () => {
    const target = siteBlocks.find((b) => b.id === BLOCK_ID)!
    assert.equal(target.isCustom, true) // deliberately targeting the genuinely-custom row, not the built-in one
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

  test('site:blocks on this site may delete an isCustom: true block (OpenProject #2128: chosen resolution is to allow this, not incidental)', async () => {
    const target = siteBlocks.find((b) => b.id === BLOCK_ID)!
    assert.equal(target.isCustom, true) // deliberately targeting the genuinely-custom row, not the built-in one
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

describe('PUT /sites/:siteId/blocks (per-block config passthrough)', () => {
  /**
   * Regression coverage for `PUT /sites/:siteId/blocks` threading a per-block `config` object through
   * to `WIKI.models.blocks.setBlocksState` — the wiring a site-wide "Server" default for block-kroki and
   * block-plantuml depends on. `WIKI.models.blocks` is stubbed rather than backed by a real database:
   * the model's own write behavior has its own unit coverage in `models/blocks.test.ts`, and this test
   * is only about whether the route passes the request body through correctly.
   */
  const SITE_ID = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
  const BLOCK_ID = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2'

  let app: FastifyInstance
  let lastCall: { siteId: string; states: any[] } | null
  let perTestWiki: { restore(): void }

  before(async () => {
    // -> See the upload describe above: the unknown-site 404 is this hook's job now (spec D1).
    const guardedRoutes: FastifyPluginAsync = async (instance) => {
      instance.addHook('preHandler', siteEnabledPreHandler)
      await instance.register(blocksRoutes)
    }

    app = await buildTestApp({
      routes: guardedRoutes,
      ajv: true,
      // -> The upload route's `addContentTypeParser` reads `WIKI.config.security.uploadMaxFileSize`
      //    at plugin-registration time, before `beforeEach`'s own (fuller) stub is in place.
      wiki: { config: { security: { uploadMaxFileSize: 10485760 } } }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    lastCall = null
    perTestWiki = installTestWiki({
      config: { security: { uploadMaxFileSize: 10485760 } },
      sites: { [SITE_ID]: { id: SITE_ID } },
      models: {
        blocks: {
          setBlocksState: async (siteId: string, states: any[]) => {
            lastCall = { siteId, states }
            return states.length
          }
        },
        groups: {
          actorForRequest: () => ({ permissions: ['manage:sites'] }),
          checkSiteAccess: () => true,
          checkSiteAdminAccess: () => true
        },
        approvals: {
          getActorGroupIds: () => [],
          getRules: async () => []
        }
      }
    })
  })

  afterEach(() => {
    perTestWiki.restore()
  })

  test('a state entry with a config object passes it straight through to the model', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/blocks`,
      payload: {
        states: [
          {
            id: BLOCK_ID,
            isEnabled: true,
            config: { server: 'https://kroki.example.com' }
          }
        ]
      }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
    assert.deepEqual(lastCall?.states, [
      { id: BLOCK_ID, isEnabled: true, config: { server: 'https://kroki.example.com' } }
    ])
  })

  test('a state entry without config is still accepted, and reaches the model with none', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/blocks`,
      payload: {
        states: [{ id: BLOCK_ID, isEnabled: false }]
      }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(lastCall?.states, [{ id: BLOCK_ID, isEnabled: false }])
  })

  test('a CustomError from the model (e.g. an invalid block-plantuml "server") surfaces its own status code, not a generic 500', async () => {
    ;(globalThis as any).WIKI.models.blocks.setBlocksState = async () => {
      const { CustomError } = await import('../helpers/common.ts')
      throw new CustomError('blocksInvalidConfig', '"not a url" is not a valid URL.', 400)
    }

    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/blocks`,
      payload: {
        states: [{ id: BLOCK_ID, isEnabled: true, config: { server: 'not a url' } }]
      }
    })

    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /not a valid URL/)
  })
})
