import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import blocksRoutes from './blocks.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

/**
 * `/_blocks/custom/:siteId/:fileName` — a unit-level test of the controller's own wiring (id
 * validation, lookup, headers), the same way `api/blocks.test.ts` covers the upload route without a
 * real database: `WIKI.models.blocks.getCustomBlockCode` is stubbed rather than pulling in Drizzle.
 *
 * The route is public (see the file's own doc comment for why), so unlike `api/blocks.test.ts` there
 * is no `config: { permissions }` to note as out of scope here.
 */

const SITE_ID = '11111111-1111-4111-8111-111111111111'
const BLOCK_ID = '22222222-2222-4222-8222-222222222222'
const CODE = Buffer.from("customElements.define('block-widget', class extends HTMLElement {})")

let app: FastifyInstance
let getCustomBlockCodeCalls: { siteId: string; id: string }[]

before(async () => {
  wikiHandle = installTestWiki({
    models: {
      blocks: {
        getCustomBlockCode: async (siteId: string, id: string) => {
          getCustomBlockCodeCalls.push({ siteId, id })
          return siteId === SITE_ID && id === BLOCK_ID ? CODE : undefined
        }
      }
    }
  })

  app = fastify()
  await app.register(fastifySensible)
  await app.register(blocksRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  wikiHandle.restore()
})

test('streams a known custom block’s code with an immutable cache header', async () => {
  getCustomBlockCodeCalls = []
  const res = await app.inject({ method: 'GET', url: `/${SITE_ID}/${BLOCK_ID}.js` })

  assert.equal(res.statusCode, 200)
  assert.equal(res.body, CODE.toString())
  assert.match(res.headers['content-type'] as string, /^application\/javascript/)
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.ok(res.headers.etag)
  assert.deepEqual(getCustomBlockCodeCalls, [{ siteId: SITE_ID, id: BLOCK_ID }])
})

test('answers 304 when the client already has the current ETag', async () => {
  const first = await app.inject({ method: 'GET', url: `/${SITE_ID}/${BLOCK_ID}.js` })
  const res = await app.inject({
    method: 'GET',
    url: `/${SITE_ID}/${BLOCK_ID}.js`,
    headers: { 'if-none-match': first.headers.etag as string }
  })

  assert.equal(res.statusCode, 304)
})

test('404s for a block id with no stored code', async () => {
  const otherId = '33333333-3333-4333-8333-333333333333'
  const res = await app.inject({ method: 'GET', url: `/${SITE_ID}/${otherId}.js` })

  assert.equal(res.statusCode, 404)
})

test('404s for a malformed site id or block id rather than reaching the model', async () => {
  getCustomBlockCodeCalls = []
  const res = await app.inject({ method: 'GET', url: `/not-a-uuid/${BLOCK_ID}.js` })

  assert.equal(res.statusCode, 404)
  assert.deepEqual(getCustomBlockCodeCalls, [])
})
