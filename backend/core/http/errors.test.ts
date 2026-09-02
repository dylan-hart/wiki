import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fastify from 'fastify'
import fastifySensible from '@fastify/sensible'

import { registerErrorHandler } from './errors.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * `registerErrorHandler` is one `if`, and that `if` is the whole point of the file: which of the two
 * bodies an uncaught error answers with is decided by `req.url.includes('/_api/')` alone. Both
 * halves had their own coverage (`helpers/errorHandler.test.ts`), but nothing exercised the dispatch
 * between them — so a route mounted at a surface it did not expect could have started disclosing
 * `error.message` (or stopped answering the documented `/_api/` shape) with nothing failing.
 *
 * Built with a bare `fastify()` rather than `test/fastify.ts#buildTestApp`: the harness installs the
 * `/_api/` handler DIRECTLY (every suite that uses it mounts one route plugin at `/`, where the
 * dispatch would never fire), and what is under test here is the dispatching wrapper itself.
 */
describe('registerErrorHandler', () => {
  let app: FastifyInstance
  let wikiHandle: { restore(): void }

  before(async () => {
    wikiHandle = installTestWiki()

    const throwingRoutes: FastifyPluginAsync = async (instance) => {
      // -> A deliberate `@fastify/sensible` error: its message is curated for disclosure, so both
      //    branches answer it as-is.
      instance.get('/_api/deliberate', async (_req, reply) => reply.notFound('No such page.'))
      instance.get('/other/deliberate', async (_req, reply) => reply.notFound('No such page.'))
      // -> An unexpected throw, whose message names internals: this is the case the two branches
      //    treat differently only in `error`, and where the non-API branch must not leak.
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

  test('an /_api/ URL is answered by the API branch', async () => {
    const res = await app.inject({ method: 'GET', url: '/_api/deliberate' })
    assert.equal(res.statusCode, 404)
    assert.deepEqual(res.json(), {
      ok: false,
      error: 'NotFoundError',
      statusCode: 404,
      message: 'No such page.'
    })

    const unexpected = await app.inject({ method: 'GET', url: '/_api/boom' })
    assert.equal(unexpected.statusCode, 500)
    assert.deepEqual(unexpected.json(), {
      ok: false,
      error: 'Internal Server Error',
      statusCode: 500,
      message: 'Internal Server error'
    })
  })

  test('every other URL is answered by the disclosure-safe branch', async () => {
    const res = await app.inject({ method: 'GET', url: '/other/deliberate' })
    assert.equal(res.statusCode, 404)
    assert.deepEqual(res.json(), {
      ok: false,
      error: 'NotFoundError',
      statusCode: 404,
      message: 'No such page.'
    })

    const unexpected = await app.inject({ method: 'GET', url: '/other/boom' })
    assert.equal(unexpected.statusCode, 500)
    // -> The deployment path the thrown `ENOENT` carried never reaches the client.
    assert.equal(unexpected.body.includes('/srv/wiki'), false)
    assert.deepEqual(unexpected.json(), {
      ok: false,
      error: 'Internal Server Error',
      statusCode: 500,
      message: 'Internal Server error'
    })
  })
})
