import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import blocksRoutes from './blocks.ts'
import { registerSchemas as registerBlockSchema } from './schemas/block.ts'

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
