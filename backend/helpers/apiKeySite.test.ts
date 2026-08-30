import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { apiKeySitePinHook, enforceApiKeySite } from './apiKeySite.ts'

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

/**
 * `apiKeySitePinHook` (OpenProject #2194): the global `preHandler` covering every `/_api/sites/:siteId/
 * ...` route in one place, registered once in `index.ts` rather than a call added to each route. Built
 * against a small representative slice of that surface — a GET, a PATCH, a DELETE and an upload-shaped
 * POST, all under the real `/_api/sites/:siteId/...` prefix — rather than the full 175-route table,
 * which `test/apiKeySitePinCoverage.test.ts` covers structurally instead (every real registered route
 * carrying a `:siteId` param really does sit under this prefix, so this hook really does reach it).
 */
describe('apiKeySitePinHook', () => {
  let hookApp: FastifyInstance

  before(async () => {
    hookApp = fastify()
    await hookApp.register(fastifySensible)
    hookApp.addHook('preHandler', (req, _reply, done) => {
      const scoped = req.headers['x-scoped-site']
      ;(req as any).apiKey = scoped
        ? { id: 'key-1', permissions: [], siteId: scoped }
        : req.headers['x-no-key']
          ? null
          : { id: 'key-1', permissions: [], siteId: null }
      done()
    })
    hookApp.addHook('preHandler', apiKeySitePinHook)

    hookApp.get<{ Params: { siteId: string } }>('/_api/sites/:siteId/pages/:pageId', async () => ({
      ok: true
    }))
    hookApp.patch<{ Params: { siteId: string; pageId: string } }>(
      '/_api/sites/:siteId/pages/:pageId',
      async () => ({ ok: true })
    )
    hookApp.delete<{ Params: { siteId: string; pageId: string } }>(
      '/_api/sites/:siteId/pages/:pageId',
      async () => ({ ok: true })
    )
    hookApp.post<{ Params: { siteId: string } }>('/_api/sites/:siteId/assets', async () => ({
      ok: true
    }))
    // -> Same param NAME, deliberately OUTSIDE `/_api/sites/` -- `controllers/site.ts`'s real route
    //    shape, whose `:siteId` can be the literal sentinel `'current'` rather than a real site id.
    //    The hook must leave it alone; `controllers/site.ts` calls `enforceApiKeySite()` itself once
    //    it has resolved a real site (OpenProject #2201).
    hookApp.get<{ Params: { siteId: string; resource: string } }>(
      '/_site/:siteId/:resource',
      async () => ({ ok: true })
    )
    await hookApp.ready()
  })

  after(async () => {
    await hookApp.close()
  })

  for (const [method, url] of [
    ['GET', `/_api/sites/${SITE_A}/pages/some-page`],
    ['PATCH', `/_api/sites/${SITE_A}/pages/some-page`],
    ['DELETE', `/_api/sites/${SITE_A}/pages/some-page`],
    ['POST', `/_api/sites/${SITE_A}/assets`]
  ] as const) {
    test(`${method}: refuses with 403 when the key is pinned to a different site`, async () => {
      const res = await hookApp.inject({
        method,
        url,
        headers: { 'x-scoped-site': SITE_B }
      })
      assert.equal(res.statusCode, 403)
    })

    test(`${method}: lets an unpinned (null siteId) key through`, async () => {
      const res = await hookApp.inject({ method, url })
      assert.equal(res.statusCode, 200)
    })

    test(`${method}: lets a key pinned to the matching site through`, async () => {
      const res = await hookApp.inject({
        method,
        url,
        headers: { 'x-scoped-site': SITE_A }
      })
      assert.equal(res.statusCode, 200)
    })
  }

  test('does not touch a route outside /_api/sites/ that happens to share the :siteId param name', async () => {
    const res = await hookApp.inject({
      method: 'GET',
      url: '/_site/current/logo',
      headers: { 'x-scoped-site': SITE_A }
    })
    // -> Would be 403 if the hook matched on param name alone rather than the URL prefix: 'current'
    //    is never equal to SITE_A. Passing through to the (stubbed, always-200) handler proves the
    //    hook left this route alone, as designed.
    assert.equal(res.statusCode, 200)
  })
})
