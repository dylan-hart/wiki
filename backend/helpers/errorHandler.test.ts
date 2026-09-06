import assert from 'node:assert/strict'
import { after, before, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { apiErrorHandler, buildNonApiErrorResponse, sendNonApiError } from './errorHandler.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

describe('buildNonApiErrorResponse', () => {
  test('an error with no statusCode collapses to a generic 500 body carrying no message/code text', () => {
    const error: any = new Error(
      "ENOENT: no such file or directory, open '/data/cache/files/secret-path'"
    )
    error.code = 'ENOENT'
    const { statusCode, body } = buildNonApiErrorResponse(error)
    assert.equal(statusCode, 500)
    assert.deepEqual(body, {
      ok: false,
      error: 'Internal Server Error',
      statusCode: 500,
      message: 'Internal Server error'
    })
    const serialized = JSON.stringify(body)
    assert.ok(!serialized.includes('ENOENT'))
    assert.ok(!serialized.includes('secret-path'))
  })

  test('a deliberate error carrying a statusCode (as @fastify/sensible sets) is passed through as-is', () => {
    const error: any = new Error('This page could not be found.')
    error.name = 'NotFoundError'
    error.statusCode = 404
    const { statusCode, body } = buildNonApiErrorResponse(error)
    assert.equal(statusCode, 404)
    assert.deepEqual(body, {
      ok: false,
      error: 'NotFoundError',
      statusCode: 404,
      message: 'This page could not be found.'
    })
  })
})

/**
 * `sendNonApiError` is wired as `index.ts`'s actual non-`/_api` `setErrorHandler` branch here, driven
 * through a real Fastify instance (`app.inject`) rather than hand-built request/reply stand-ins --
 * same technique `helpers/rateLimit.test.ts` uses for the same reason: reply/error interplay
 * (`reply.code().type().send()`, `@fastify/sensible`'s thrown `httpErrors`) is exactly what would be
 * re-describing Fastify's own behavior if mocked instead of exercised.
 */
describe('sendNonApiError', () => {
  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({ logger: { error: mock.fn(), warn: mock.fn() } })
    app = fastify()
    await app.register(fastifySensible)
    app.setErrorHandler((error: any, _req, reply) => sendNonApiError(error, reply))
    app.get('/boom-generic', async () => {
      throw new Error("ENOENT: no such file or directory, open '/data/cache/files/secret-path'")
    })
    app.get('/boom-sensible', async () => {
      throw app.httpErrors.notFound('This page could not be found.')
    })
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  test('an unmarked error answers a generic 500 with no leaked detail, and is logged via WIKI.logger.error', async () => {
    ;(globalThis as any).WIKI.logger.error.mock.resetCalls()
    ;(globalThis as any).WIKI.logger.warn.mock.resetCalls()
    const res = await app.inject({ method: 'GET', url: '/boom-generic' })
    assert.equal(res.statusCode, 500)
    assert.deepEqual(res.json(), {
      ok: false,
      error: 'Internal Server Error',
      statusCode: 500,
      message: 'Internal Server error'
    })
    assert.ok(!res.body.includes('secret-path'))
    assert.ok(!res.body.includes('ENOENT'))
    assert.equal((globalThis as any).WIKI.logger.error.mock.calls.length, 1)
    const [scope, message, fields] = (globalThis as any).WIKI.logger.error.mock.calls[0].arguments
    assert.equal(scope, 'http')
    assert.equal(message, 'unhandled error outside /_api')
    // -> The error rides `fields.error`, not the message: the renderer is what turns it into
    //    `error="…"` plus a stack, so the sentence stays a sentence.
    assert.ok((fields.error as Error).message.includes('secret-path'))
    // -> Bug #2650: this used to be `warn`, one level below the threshold an operator alerts on, so
    //    a crashed request was invisible to them. Asserted as a level, not merely as "something was
    //    logged".
    assert.equal((globalThis as any).WIKI.logger.warn.mock.calls.length, 0)
  })

  test('a deliberate @fastify/sensible error answers its own status and message, and is logged via WIKI.logger.error', async () => {
    ;(globalThis as any).WIKI.logger.error.mock.resetCalls()
    const res = await app.inject({ method: 'GET', url: '/boom-sensible' })
    assert.equal(res.statusCode, 404)
    const body = res.json()
    assert.equal(body.statusCode, 404)
    assert.equal(body.message, 'This page could not be found.')
    assert.equal((globalThis as any).WIKI.logger.error.mock.calls.length, 1)
  })
})

/**
 * The `/_api` branch of the same `setErrorHandler`, lifted out of `index.ts` by task A15 so the real
 * one can be installed by a test harness rather than approximated by the >= 57 hand-rolled copies
 * TEST-F2 counted across the API suites. Driven through a real Fastify instance for the same reason
 * `sendNonApiError` above is.
 */
describe('apiErrorHandler', () => {
  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({ logger: { error: mock.fn(), warn: mock.fn() } })
    app = fastify()
    await app.register(fastifySensible)
    app.setErrorHandler(apiErrorHandler)
    app.get('/_api/boom-generic', async () => {
      throw new Error('relation "pages" does not exist at character 42')
    })
    app.get('/_api/boom-sensible', async () => {
      throw app.httpErrors.forbidden('You may not do that.')
    })
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  test('an error carrying a statusCode answers that status with the { ok, error, statusCode, message } body', async () => {
    ;(globalThis as any).WIKI.logger.error.mock.resetCalls()
    ;(globalThis as any).WIKI.logger.warn.mock.resetCalls()
    const res = await app.inject({ method: 'GET', url: '/_api/boom-sensible' })
    assert.equal(res.statusCode, 403)
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
    assert.deepEqual(res.json(), {
      ok: false,
      error: 'ForbiddenError',
      statusCode: 403,
      message: 'You may not do that.'
    })
    // -> A deliberate refusal is not an operator's problem: only the bare-500 branch logs, and
    //    Phase 1's access line (#2660) is what will account for 4xx.
    assert.equal((globalThis as any).WIKI.logger.error.mock.calls.length, 0)
    assert.equal((globalThis as any).WIKI.logger.warn.mock.calls.length, 0)
  })

  test('an unmarked error answers a generic 500 whose body leaks nothing from the original', async () => {
    ;(globalThis as any).WIKI.logger.error.mock.resetCalls()
    const res = await app.inject({ method: 'GET', url: '/_api/boom-generic' })
    assert.equal(res.statusCode, 500)
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
    assert.deepEqual(res.json(), {
      ok: false,
      error: 'Internal Server Error',
      statusCode: 500,
      message: 'Internal Server error'
    })
    assert.ok(!res.body.includes('relation'))
  })

  test('the bare-500 branch logs the error with the request context that correlates it', async () => {
    ;(globalThis as any).WIKI.logger.error.mock.resetCalls()
    ;(globalThis as any).WIKI.logger.warn.mock.resetCalls()
    await app.inject({ method: 'GET', url: '/_api/boom-generic' })
    const calls = (globalThis as any).WIKI.logger.error.mock.calls
    assert.equal(calls.length, 1)
    // -> Bug #2650: at `error`, never at `warn`.
    assert.equal((globalThis as any).WIKI.logger.warn.mock.calls.length, 0)
    const [scope, message, fields] = calls[0].arguments
    assert.equal(scope, 'http')
    assert.equal(message, 'unhandled error, answered 500')
    assert.match((fields.error as Error).message, /relation "pages" does not exist/)
    // -> `buildErrorLogContext`'s keys are spread into the same fields object as the error, so one
    //    record carries both the cause and the request that produced it.
    assert.equal(fields.method, 'GET')
    assert.equal(fields.url, '/_api/boom-generic')
    assert.equal(typeof fields.reqId, 'string')
    assert.equal(fields.userId, undefined)
  })
})
