import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

import {
  buildTestApp,
  closeTestApp,
  makeDoneStub,
  makeReplyStub,
  makeRequestStub
} from './fastify.ts'
import { permissionPreHandler } from '../core/http/authHooks.ts'

/**
 * The harness's own regression coverage.
 *
 * The one thing worth proving directly rather than through a converted suite: `buildTestApp` runs the
 * REAL `core/http/authHooks.ts#permissionPreHandler`, not an approximation of it — including the
 * `req.apiKey` branch that all six hand-written replicas this harness replaces had dropped.
 */

/** A trivial route pair: one permission-gated, one open, one that throws a sensible error. */
const probeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/guarded', { config: { permissions: ['manage:groups'] } }, async () => ({ ok: true }))
  app.get('/open', async () => ({ ok: true }))
  app.get('/missing', async (_req, reply) => reply.notFound('no such thing'))
}

describe('buildTestApp / permissions', () => {
  let app: FastifyInstance

  after(() => closeTestApp(app))

  test('a session without the route permission is refused 403 by the real hook', async () => {
    app = await buildTestApp({
      routes: probeRoutes,
      wiki: {},
      schemas: [],
      session: { authenticated: true, permissions: ['read:pages'] },
      permissions: true
    })
    const res = await app.inject({ method: 'GET', url: '/guarded' })
    assert.equal(res.statusCode, 403)
  })

  test('a session holding the route permission reaches the handler', async () => {
    await closeTestApp(app)
    app = await buildTestApp({
      routes: probeRoutes,
      wiki: {},
      schemas: [],
      session: { authenticated: true, permissions: ['manage:groups'] },
      permissions: true
    })
    const res = await app.inject({ method: 'GET', url: '/guarded' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true })
  })

  test('an unauthenticated request is refused 401, and an ungated route still answers', async () => {
    await closeTestApp(app)
    app = await buildTestApp({ routes: probeRoutes, wiki: {}, schemas: [], permissions: true })
    assert.equal((await app.inject({ method: 'GET', url: '/guarded' })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: '/open' })).statusCode, 200)
  })

  test('session: "header" seeds from x-test-session, x-test-permissions and x-test-api-key', async () => {
    await closeTestApp(app)
    app = await buildTestApp({
      routes: probeRoutes,
      wiki: {},
      schemas: [],
      session: 'header',
      permissions: true
    })

    const viaSession = await app.inject({
      method: 'GET',
      url: '/guarded',
      headers: {
        'x-test-session': JSON.stringify({ authenticated: true, permissions: ['manage:groups'] })
      }
    })
    assert.equal(viaSession.statusCode, 200)

    // -> Both spellings the suites had grown: a comma-separated list and a JSON array.
    const viaCsv = await app.inject({
      method: 'GET',
      url: '/guarded',
      headers: { 'x-test-permissions': 'read:pages,manage:groups' }
    })
    assert.equal(viaCsv.statusCode, 200)
    const viaJson = await app.inject({
      method: 'GET',
      url: '/guarded',
      headers: { 'x-test-permissions': JSON.stringify(['read:pages']) }
    })
    assert.equal(viaJson.statusCode, 403)

    // -> The branch every hand-written replica dropped: a verified API key stands in for a session.
    const viaApiKey = await app.inject({
      method: 'GET',
      url: '/guarded',
      headers: { 'x-test-api-key': JSON.stringify({ id: 'k1', permissions: ['manage:groups'] }) }
    })
    assert.equal(viaApiKey.statusCode, 200)
  })

  test('the real apiErrorHandler shapes a sensible error into the ApiError body', async () => {
    await closeTestApp(app)
    app = await buildTestApp({ routes: probeRoutes, wiki: {}, schemas: [] })
    const res = await app.inject({ method: 'GET', url: '/missing' })
    assert.equal(res.statusCode, 404)
    assert.deepEqual(res.json(), {
      ok: false,
      error: 'NotFoundError',
      statusCode: 404,
      message: 'no such thing'
    })
  })

  test('schemas: "all" registers the shared set, so a $ref resolves', async () => {
    await closeTestApp(app)
    const refRoutes: FastifyPluginAsync = async (instance) => {
      instance.get(
        '/err',
        { schema: { response: { 404: { $ref: 'ApiError#' } } } },
        async (_req, reply) => reply.notFound('gone')
      )
    }
    app = await buildTestApp({ routes: refRoutes, wiki: {}, schemas: 'all' })
    assert.equal((await app.inject({ method: 'GET', url: '/err' })).statusCode, 404)
  })

  test('closeTestApp restores whatever WIKI was in place before', async () => {
    await closeTestApp(app)
    const sentinel = { marker: 'outer' } as any
    ;(globalThis as any).WIKI = sentinel
    const scoped = await buildTestApp({
      routes: probeRoutes,
      wiki: { config: { a: 1 } },
      schemas: []
    })
    assert.equal((globalThis as any).WIKI.config.a, 1)
    await closeTestApp(scoped)
    assert.equal((globalThis as any).WIKI, sentinel)
    delete (globalThis as any).WIKI
    app = await buildTestApp({ routes: probeRoutes, wiki: {}, schemas: [] })
  })
})

describe('makeRequestStub / makeReplyStub / makeDoneStub', () => {
  test('drive a callback-style hook with no server around it', () => {
    const { reply, calls } = makeReplyStub()
    const { done, called } = makeDoneStub()
    const req = makeRequestStub({
      routeOptions: { config: { permissions: ['manage:system'] } },
      session: { authenticated: true, permissions: ['read:pages'] }
    })
    permissionPreHandler(req, reply, done)
    assert.equal(calls.forbidden.length, 1)
    assert.equal(called, false)
  })

  test('a hook that falls through calls done() and answers nothing', () => {
    const { reply, calls } = makeReplyStub()
    const stub = makeDoneStub()
    permissionPreHandler(makeRequestStub({ routeOptions: { config: {} } }), reply, stub.done)
    assert.equal(stub.called, true)
    assert.equal(stub.error, undefined)
    assert.deepEqual(calls.forbidden, [])
    assert.deepEqual(calls.unauthorized, [])
  })

  test('request defaults describe an anonymous /_api/ GET', () => {
    const req = makeRequestStub() as any
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/_api/pages')
    assert.equal(req.apiKey, null)
    assert.equal(req.session, undefined)
  })
})
