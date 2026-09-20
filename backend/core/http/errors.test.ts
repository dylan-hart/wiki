import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fastify from 'fastify'
import fastifySensible from '@fastify/sensible'

import { registerErrorHandler } from './errors.ts'
import { createSilentLogger, installTestWiki } from '../../test/mocks.ts'

/**
 * Both branches answer byte-identical bodies for every case, so asserting on the response cannot
 * tell them apart and a collapsed or inverted dispatch would pass. What differs is how an
 * unexpected throw is logged: `/_api/` logs `unhandled error, answered 500` with
 * `buildErrorLogContext(req)` in its fields, the other branch `unhandled error outside /_api` with
 * `{ error }` alone. `warn` is mocked only to assert that neither branch logs a crash below `error`.
 *
 * A bare `fastify()` rather than `test/fastify.ts#buildTestApp`: the harness installs the `/_api/`
 * handler directly, and the dispatching wrapper is what is under test.
 */
describe('registerErrorHandler', () => {
  let app: FastifyInstance
  let wikiHandle: { restore(): void }
  let error: ReturnType<typeof mock.fn>
  let warn: ReturnType<typeof mock.fn>

  before(async () => {
    error = mock.fn()
    warn = mock.fn()
    wikiHandle = installTestWiki({ logger: { ...createSilentLogger(), error, warn } })

    const throwingRoutes: FastifyPluginAsync = async (instance) => {
      // -> A deliberate `@fastify/sensible` error: it carries a `statusCode`, so both branches
      //    answer its curated message as-is and log nothing.
      instance.get('/_api/deliberate', async (_req, reply) => reply.notFound('No such page.'))
      instance.get('/other/deliberate', async (_req, reply) => reply.notFound('No such page.'))
      // -> An unexpected throw, whose message names internals.
      instance.get('/_api/boom', async () => {
        throw new Error('ENOENT: /srv/wiki/data/assets/secret.png')
      })
      instance.get('/other/boom', async () => {
        throw new Error('ENOENT: /srv/wiki/data/assets/secret.png')
      })
    }

    app = fastify()
    await app.register(fastifySensible)
    registerErrorHandler(app)
    await app.register(throwingRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  beforeEach(() => {
    error.mock.resetCalls()
    warn.mock.resetCalls()
  })

  test('a deliberate error stays silent on both surfaces (Bug #2837)', async () => {
    const api = await app.inject({ method: 'GET', url: '/_api/deliberate' })
    assert.equal(api.statusCode, 404)
    assert.equal(
      error.mock.calls.length,
      0,
      'the /_api/ branch answers a statusCode-carrying error without logging it'
    )

    const other = await app.inject({ method: 'GET', url: '/other/deliberate' })
    assert.equal(other.statusCode, 404)
    assert.equal(
      error.mock.calls.length,
      0,
      'the non-API branch answers a statusCode-carrying error without logging it too (Bug #2837) -- ' +
        'this used to log every deliberate 4xx (icon-set 404s and the like), flooding the logs'
    )
    assert.equal(warn.mock.calls.length, 0, 'neither branch logs at warn (#2650)')
  })

  test('an unexpected throw is logged at error by both, but only /_api/ attaches a request log context', async () => {
    const api = await app.inject({ method: 'GET', url: '/_api/boom' })
    assert.equal(api.statusCode, 500)
    assert.equal(error.mock.calls.length, 1)
    const [apiScope, apiMessage, apiFields] = error.mock.calls[0]!.arguments as [
      string,
      string,
      Record<string, unknown>
    ]
    assert.equal(apiScope, 'http')
    assert.equal(
      apiMessage,
      'unhandled error, answered 500',
      'the /_api/ branch spreads buildErrorLogContext(req) into the fields of this line'
    )
    // -> The same correlation id the `http` access line carries.
    assert.ok(apiFields.reqId)

    error.mock.resetCalls()
    const other = await app.inject({ method: 'GET', url: '/other/boom' })
    assert.equal(other.statusCode, 500)
    assert.equal(error.mock.calls.length, 1)
    const otherFields = error.mock.calls[0]!.arguments[2] as Record<string, unknown>
    assert.equal(error.mock.calls[0]!.arguments[1], 'unhandled error outside /_api')
    assert.equal(otherFields.reqId, undefined, 'the non-API branch attaches no request log context')
    // -> An operator alerting on `error` has to see a crashed request whichever handler answered.
    assert.equal(warn.mock.calls.length, 0)
  })

  test('both branches answer the documented bodies, and neither leaks the thrown message', async () => {
    for (const url of ['/_api/deliberate', '/other/deliberate']) {
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 404)
      assert.deepEqual(res.json(), {
        ok: false,
        error: 'NotFoundError',
        statusCode: 404,
        message: 'No such page.'
      })
    }
    for (const url of ['/_api/boom', '/other/boom']) {
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 500)
      assert.equal(res.body.includes('/srv/wiki'), false)
      assert.deepEqual(res.json(), {
        ok: false,
        error: 'Internal Server Error',
        statusCode: 500,
        message: 'Internal Server error'
      })
    }
  })
})
