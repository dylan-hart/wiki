import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { notModifiedOrPrepare } from './httpCache.ts'
import type { FastifyReply, FastifyRequest } from 'fastify'

/** The two pieces of a `FastifyRequest`/`FastifyReply` this helper actually touches. */
function fakeExchange(ifNoneMatch?: string) {
  const headers: Record<string, unknown> = {}
  const sent: number[] = []
  const reply = {
    header(name: string, value: unknown) {
      headers[name] = value
      return reply
    },
    code(status: number) {
      sent.push(status)
      return reply
    },
    send() {
      return reply
    }
  }
  const req = { headers: { 'if-none-match': ifNoneMatch } }
  return {
    req: req as unknown as FastifyRequest,
    reply: reply as unknown as FastifyReply,
    headers,
    sent
  }
}

describe('notModifiedOrPrepare', () => {
  test('sets ETag, Cache-Control and nosniff, and returns false for a fresh request', () => {
    const { req, reply, headers, sent } = fakeExchange()
    const answered = notModifiedOrPrepare(req, reply, {
      etag: '"abc"',
      cacheControl: 'public, no-cache'
    })
    assert.equal(answered, false)
    assert.deepEqual(headers, {
      ETag: '"abc"',
      'Cache-Control': 'public, no-cache',
      'X-Content-Type-Options': 'nosniff'
    })
    assert.deepEqual(sent, [])
  })

  test('answers 304 and returns true when If-None-Match matches the ETag', () => {
    const { req, reply, headers, sent } = fakeExchange('"abc"')
    const answered = notModifiedOrPrepare(req, reply, {
      etag: '"abc"',
      cacheControl: 'private, no-cache'
    })
    assert.equal(answered, true)
    assert.deepEqual(sent, [304])
    // -> The validator headers go out on the 304 as well, exactly as each controller sent them
    assert.equal(headers.ETag, '"abc"')
    assert.equal(headers['Cache-Control'], 'private, no-cache')
  })

  test('a stale If-None-Match is not a match', () => {
    const { req, reply, sent } = fakeExchange('"stale"')
    assert.equal(
      notModifiedOrPrepare(req, reply, { etag: '"abc"', cacheControl: 'public, no-cache' }),
      false
    )
    assert.deepEqual(sent, [])
  })

  test('omits nosniff when the caller opts out', () => {
    const { req, reply, headers } = fakeExchange()
    notModifiedOrPrepare(req, reply, {
      etag: '"abc"',
      cacheControl: 'public, no-cache',
      nosniff: false
    })
    assert.deepEqual(headers, { ETag: '"abc"', 'Cache-Control': 'public, no-cache' })
  })
})
