import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { activeBanMemo } from '../helpers/rateLimit.ts'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import { createSiteAdminAccessStub } from '../test/mocks.ts'
import blocksRoutes from './blocks.ts'
import { installTestWiki } from '../test/mocks.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

describe('POST /sites/:siteId/blocks (custom block upload)', () => {
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
    // -> The unknown-site 404 is `siteEnabledPreHandler`'s, not the route's, so a plugin-only app
    //    has to register it.
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
          },
          // -> For the upload route's `limitUploads` preHandler.
          rateLimits: {
            consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 })
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
   * The parser's `bodyLimit` is read from `CARDINAL.config.security.uploadMaxFileSize` once, at
   * plugin registration, so the cap is set first and a second app registered against it.
   */
  test('rejects a payload larger than the configured upload size cap with 413', async () => {
    CARDINAL.config.security.uploadMaxFileSize = 16
    // -> No `wiki`: build against the global the enclosing describe installed, cap aside.
    const smallApp = await buildTestApp({ routes: blocksRoutes })
    try {
      const res = await smallApp.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/blocks`,
        payload: Buffer.from(WELL_FORMED),
        headers: { 'content-type': 'text/javascript' }
      })
      assert.equal(res.statusCode, 413)
      assert.equal(createCustomBlockCalls.length, 0)
    } finally {
      await closeTestApp(smallApp)
      CARDINAL.config.security.uploadMaxFileSize = 10485760
    }
  })
})

describe('PUT/DELETE /sites/:siteId/blocks (site-scoped delegation)', () => {
  /**
   * `BLOCK_ID` is deliberately the `isCustom: true` row: `site:blocks` enabling or deleting a
   * custom block is an accepted widening (docs/audits/security-reviews/custom-block-upload.md), so
   * the tests pin it against the row that runs arbitrary script, not the built-in one.
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

  /** The `x-test-site-permissions` header lists the `permission@siteId` pairs this grants. */
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
    const guardedRoutes: FastifyPluginAsync = async (instance) => {
      instance.addHook('preHandler', siteEnabledPreHandler)
      await instance.register(blocksRoutes)
    }

    app = await buildTestApp({
      routes: guardedRoutes,
      // -> `checkSiteAccess()` takes no `req`, so the header is stashed here per request; returning
      //    `undefined` leaves the request anonymous.
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
    assert.equal(target.isCustom, true)
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
    assert.equal(target.isCustom, true)
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
  const SITE_ID = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
  const BLOCK_ID = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2'

  let app: FastifyInstance
  let lastCall: { siteId: string; states: any[] } | null
  let perTestWiki: { restore(): void }

  before(async () => {
    const guardedRoutes: FastifyPluginAsync = async (instance) => {
      instance.addHook('preHandler', siteEnabledPreHandler)
      await instance.register(blocksRoutes)
    }

    app = await buildTestApp({
      routes: guardedRoutes,
      ajv: true,
      // -> Plugin registration reads `CARDINAL.config.security.uploadMaxFileSize`, before
      //    `beforeEach`'s fuller stub exists.
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
    ;(globalThis as any).CARDINAL.models.blocks.setBlocksState = async () => {
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

describe('UPLOAD CUSTOM BLOCK route: rate limit (OpenProject #3234)', () => {
  const SITE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

  const WELL_FORMED = `
export class BlockWidget extends HTMLElement {
  static definition = {
    block: 'widget2',
    name: 'Widget2',
    description: 'A test widget.',
    icon: 'mdi:cube'
  }
}
customElements.define('block-widget2', BlockWidget)
`

  let createCustomBlockCalls: number
  let consumeCalls: { key: string }[]
  let allowed: boolean

  let app: FastifyInstance

  before(async () => {
    const guardedRoutes: FastifyPluginAsync = async (instance) => {
      instance.addHook('preHandler', siteEnabledPreHandler)
      await instance.register(blocksRoutes)
    }

    app = await buildTestApp({
      routes: guardedRoutes,
      session: 'header',
      permissions: true,
      wiki: {
        config: { security: { uploadMaxFileSize: 10485760 } },
        sites: { [SITE_ID]: { id: SITE_ID, isEnabled: true } },
        models: {
          blocks: {
            isTagTaken: async () => false,
            createCustomBlock: async () => {
              createCustomBlockCalls++
              return { id: 'new-block-id', block: 'widget2', elementTag: 'block-widget2' }
            }
          },
          rateLimits: {
            consume: async (key: string) => {
              consumeCalls.push({ key })
              return allowed
                ? { allowed: true, hits: 1, retryAfter: 0 }
                : { allowed: false, hits: 21, retryAfter: 45 }
            }
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  function sessionHeader() {
    return {
      'x-test-session': JSON.stringify({
        authenticated: true,
        user: { id: 'admin-1' },
        permissions: ['manage:sites']
      })
    }
  }

  test('a burst exceeding the limit is rejected with 429 and Retry-After, without reaching createCustomBlock()', async () => {
    createCustomBlockCalls = 0
    consumeCalls = []
    allowed = false
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/blocks`,
      headers: { ...sessionHeader(), 'content-type': 'text/javascript' },
      payload: Buffer.from(WELL_FORMED)
    })
    assert.equal(res.statusCode, 429)
    assert.equal(res.headers['retry-after'], '45')
    assert.equal(createCustomBlockCalls, 0)
    assert.equal(consumeCalls.length, 1)
    assert.equal(consumeCalls[0].key, 'upload:admin-1')
  })

  test('normal single-file usage (one upload at a time) is unaffected', async () => {
    // -> The previous test's refusal is memoized in the shared `activeBanMemo`, which would refuse
    //    this request before it reached `consume()`.
    activeBanMemo.clear()
    createCustomBlockCalls = 0
    consumeCalls = []
    allowed = true
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/blocks`,
      headers: { ...sessionHeader(), 'content-type': 'text/javascript' },
      payload: Buffer.from(WELL_FORMED)
    })
    assert.equal(res.statusCode, 200)
    assert.equal(createCustomBlockCalls, 1)
    assert.equal(consumeCalls.length, 1)
  })
})
