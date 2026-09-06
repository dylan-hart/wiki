import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fastify from 'fastify'
import fastifySensible from '@fastify/sensible'

import { registerErrorHandler } from './errors.ts'
import { createSilentLogger, installTestWiki } from '../../test/mocks.ts'

/**
 * `registerErrorHandler` is one `if`, and that `if` is the whole point of the file: which of the two
 * handlers an uncaught error reaches is decided by `req.url.includes('/_api/')` alone. Both halves
 * have their own coverage (`helpers/errorHandler.test.ts`); what nothing exercised is the dispatch
 * between them.
 *
 * The two branches answer BYTE-IDENTICAL bodies for every case — `apiErrorHandler` and
 * `sendNonApiError` build the same `{ ok, error, statusCode, message }` shape and collapse an
 * unexpected throw to the same generic 500 — so asserting on the response cannot tell them apart, and
 * a collapsed or inverted `if` would pass. What DOES differ is the logging:
 *
 * | probe                | `/_api/` branch                       | non-API branch          |
 * | -------------------- | ------------------------------------- | ----------------------- |
 * | 404 (has statusCode) | silent (answered as-is)               | logs, one argument      |
 * | 500 (unexpected)     | logs, plus `buildErrorLogContext(req)` | logs, one argument      |
 *
 * so this suite asserts on `WIKI.logger.error`'s call count and arity per probe — at `error`, which
 * is Bug #2650: both branches used to log a crashed request at `warn`, one level below what an
 * operator alerts on, so a 500 was indistinguishable from a routine notice. `warn` is mocked
 * alongside purely to assert it is NOT the level either branch reaches for. Built with a bare
 * `fastify()` rather than `test/fastify.ts#buildTestApp`: the harness installs the `/_api/` handler
 * DIRECTLY (every suite that uses it mounts one route plugin at `/`, where the dispatch would never
 * fire), and the dispatching wrapper is exactly what is under test.
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
      //    answer its curated message as-is — and only the non-API one logs it.
      instance.get('/_api/deliberate', async (_req, reply) => reply.notFound('No such page.'))
      instance.get('/other/deliberate', async (_req, reply) => reply.notFound('No such page.'))
      // -> An unexpected throw, whose message names internals: both branches collapse it to the same
      //    generic 500 body, and both log it — but only the `/_api/` one attaches a log context.
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

  test('a deliberate error is logged on the non-API surface and stays silent under /_api/', async () => {
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
      1,
      'the non-API branch logs every error it answers, deliberate ones included'
    )
    assert.equal(error.mock.calls[0]!.arguments.length, 1)
    assert.equal(warn.mock.calls.length, 0, 'neither branch logs at warn (#2650)')
  })

  test('an unexpected throw is logged at error by both, but only /_api/ attaches a request log context', async () => {
    const api = await app.inject({ method: 'GET', url: '/_api/boom' })
    assert.equal(api.statusCode, 500)
    assert.equal(error.mock.calls.length, 1)
    const apiArgs = error.mock.calls[0]!.arguments
    assert.equal(apiArgs.length, 2, 'the /_api/ branch logs buildErrorLogContext(req) alongside it')
    // -> `req.id` is the same correlation id Fastify's own access log carries, which is the whole
    //    point of the second argument.
    assert.ok((apiArgs[1] as Record<string, unknown>).reqId)

    error.mock.resetCalls()
    const other = await app.inject({ method: 'GET', url: '/other/boom' })
    assert.equal(other.statusCode, 500)
    assert.equal(error.mock.calls.length, 1)
    assert.equal(error.mock.calls[0]!.arguments.length, 1)
    // -> An unhandled exception is `error` on BOTH surfaces, never `warn` (#2650): an operator
    //    alerting on `error` has to see a crashed request whichever handler answered it.
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
      // -> The deployment path the thrown `ENOENT` carried never reaches the client, on either
      //    surface.
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
