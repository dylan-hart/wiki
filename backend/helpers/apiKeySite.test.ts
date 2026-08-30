import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { apiKeySitePinPreHandler, enforceApiKeySite } from './apiKeySite.ts'

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
 * OpenProject #2189/#2194: the site pin used to have to be remembered route by route
 * (`enforceApiKeySite()` above) -- 2 of 117 `/sites/:siteId/...` routes actually called it. This
 * suite covers the fix: ONE global `preHandler`, registered once, closes every route with a
 * `:siteId` param at once -- including a brand-new route that never heard of this file, which is
 * exactly the regression the fix was meant to make impossible. `index.ts` registers the identical
 * function; this exercises it directly rather than re-deriving the same assertions against a copy.
 */
describe('apiKeySitePinPreHandler (global, covers every route automatically)', () => {
  let hookApp: FastifyInstance

  before(async () => {
    hookApp = fastify()
    await hookApp.register(fastifySensible)
    // -> Mirrors index.ts's real ordering: the key is resolved onto `req.apiKey` in an EARLIER
    //    lifecycle phase (there, `onRequest`) before the site-pin preHandler ever runs, so it sets
    //    `req.apiKey` first here too.
    hookApp.addHook('onRequest', (req, _reply, done) => {
      const scoped = req.headers['x-scoped-site']
      ;(req as any).apiKey = scoped
        ? { id: 'key-1', permissions: [], siteId: scoped }
        : req.headers['x-no-key']
          ? null
          : { id: 'key-1', permissions: [], siteId: null }
      done()
    })
    // -> Registered ONCE, globally -- mirrors exactly how index.ts wires it in, ahead of every
    //    route below, none of which call anything from this file themselves.
    hookApp.addHook('preHandler', apiKeySitePinPreHandler)

    // -> A representative slice of the real surface's route shapes: GET/PATCH/DELETE, and a route
    //    with an extra param segment (asset-upload-shaped), each simply returning ok -- there is
    //    nothing route-specific to opt into, which is the whole point.
    for (const method of ['get', 'patch', 'delete'] as const) {
      hookApp[method]<{ Params: { siteId: string } }>(
        `/sites/:siteId/probe-${method}`,
        async () => ({ ok: true })
      )
    }
    hookApp.post<{ Params: { siteId: string; assetId: string } }>(
      '/sites/:siteId/assets/:assetId',
      async () => ({ ok: true })
    )
    // -> A route with NO :siteId at all (an instance-wide resource) -- must never be gated by this
    //    hook, since there is nothing on it to compare a pin against.
    hookApp.get('/groups/:groupId', async () => ({ ok: true }))
    // -> Registered LAST, after every route above already exists -- proving the hook (registered
    //    before any of them) still covers a route added afterward, the way a real future PR would.
    hookApp.put<{ Params: { siteId: string } }>('/sites/:siteId/probe-late', async () => ({
      ok: true
    }))

    await hookApp.ready()
  })

  after(async () => {
    await hookApp.close()
  })

  for (const [method, url] of [
    ['GET', `/sites/${SITE_A}/probe-get`],
    ['PATCH', `/sites/${SITE_A}/probe-patch`],
    ['DELETE', `/sites/${SITE_A}/probe-delete`],
    ['POST', `/sites/${SITE_A}/assets/33333333-3333-3333-3333-333333333333`],
    ['PUT', `/sites/${SITE_A}/probe-late`]
  ] as const) {
    test(`${method} ${url}: a key pinned to a DIFFERENT site is refused with 403`, async () => {
      const res = await hookApp.inject({
        method,
        url,
        headers: { 'x-scoped-site': SITE_B }
      })
      assert.equal(res.statusCode, 403)
    })

    test(`${method} ${url}: a key pinned to the SAME site passes through`, async () => {
      const res = await hookApp.inject({
        method,
        url,
        headers: { 'x-scoped-site': SITE_A }
      })
      assert.equal(res.statusCode, 200)
    })
  }

  test('an unpinned key (siteId: null) reaches any site', async () => {
    const res = await hookApp.inject({ method: 'GET', url: `/sites/${SITE_B}/probe-get` })
    assert.equal(res.statusCode, 200)
  })

  test('a request with no API key at all is unaffected', async () => {
    const res = await hookApp.inject({
      method: 'GET',
      url: `/sites/${SITE_A}/probe-get`,
      headers: { 'x-no-key': '1' }
    })
    assert.equal(res.statusCode, 200)
  })

  test('a route with no :siteId param at all is never gated, even for a pinned key', async () => {
    const res = await hookApp.inject({
      method: 'GET',
      url: '/groups/some-group-id',
      headers: { 'x-scoped-site': SITE_A }
    })
    assert.equal(res.statusCode, 200)
  })
})
