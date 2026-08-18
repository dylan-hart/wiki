import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { enforceApiKeySite } from './apiKeySite.ts'

/**
 * `enforceApiKeySite` writes the 403 itself via `reply.forbidden()`, so — like `limitApiKey` in
 * `rateLimit.test.ts` — it is exercised against a real fastify instance with `@fastify/sensible`
 * registered rather than a hand-rolled reply stub.
 */

const SITE_A = '11111111-1111-1111-1111-111111111111'
const SITE_B = '22222222-2222-2222-2222-222222222222'

let app: FastifyInstance

before(async () => {
  app = fastify()
  await app.register(fastifySensible)
  app.get<{ Params: { siteId: string } }>(
    '/probe/:siteId',
    {
      preHandler: (req, _reply) => {
        const scoped = req.headers['x-scoped-site']
        ;(req as any).apiKey = scoped
          ? { id: 'key-1', permissions: [], siteId: scoped }
          : req.headers['x-no-key']
            ? null
            : { id: 'key-1', permissions: [], siteId: null }
        return Promise.resolve()
      }
    },
    async (req, reply) => {
      if (!enforceApiKeySite(req, reply, req.params.siteId)) {
        return reply
      }
      return { ok: true }
    }
  )
  await app.ready()
})

after(async () => {
  await app.close()
})

test('lets the request through when the key is unscoped (siteId: null)', async () => {
  const res = await app.inject({ method: 'GET', url: `/probe/${SITE_A}` })
  assert.equal(res.statusCode, 200)
})

test('lets the request through when the key is not present at all', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/probe/${SITE_A}`,
    headers: { 'x-no-key': '1' }
  })
  assert.equal(res.statusCode, 200)
})

test('lets the request through when the scoped site matches the resource site', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/probe/${SITE_A}`,
    headers: { 'x-scoped-site': SITE_A }
  })
  assert.equal(res.statusCode, 200)
})

test('refuses with 403 when the scoped site does not match the resource site', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/probe/${SITE_A}`,
    headers: { 'x-scoped-site': SITE_B }
  })
  assert.equal(res.statusCode, 403)
})
