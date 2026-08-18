import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import blocksRoutes from './blocks.ts'
import { registerSchemas as registerBlockSchema } from './schemas/block.ts'

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

before(async () => {
  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
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
  lastCall = null
  ;(globalThis as any).WIKI = {
    models: {
      sites: {
        getSiteById: async ({ id }: { id: string }) => (id === SITE_ID ? { id } : null)
      },
      blocks: {
        setBlocksState: async (siteId: string, states: any[]) => {
          lastCall = { siteId, states }
          return states.length
        }
      }
    },
    logger: { warn: () => {} }
  }
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
