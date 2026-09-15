import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { installTestWiki } from '../test/mocks.ts'
import { makeReplyStub } from '../test/fastify.ts'
import {
  API_NOT_READY_MESSAGE,
  API_NOT_READY_RETRY_AFTER_SECONDS,
  apiReadinessOnRequest,
  guardApiReady
} from './apiReadiness.ts'

describe('guardApiReady', () => {
  let wikiHandle: { restore(): void } | undefined

  afterEach(() => {
    wikiHandle?.restore()
    wikiHandle = undefined
  })

  test('a ready instance passes the request through untouched', () => {
    wikiHandle = installTestWiki({ server: { isReady: () => true } })
    const { reply, calls } = makeReplyStub()

    const handled = guardApiReady(reply)

    assert.equal(handled, false)
    assert.deepEqual(calls.serviceUnavailable, [])
    assert.equal((reply.header as any).mock.calls.length, 0)
  })

  test('a not-ready instance answers 503 with Retry-After and the fixed message', () => {
    wikiHandle = installTestWiki({ server: { isReady: () => false } })
    const { reply, calls } = makeReplyStub()

    const handled = guardApiReady(reply)

    assert.equal(handled, true)
    assert.deepEqual(calls.serviceUnavailable, [API_NOT_READY_MESSAGE])
    assert.deepEqual((reply.header as any).mock.calls[0].arguments, [
      'Retry-After',
      String(API_NOT_READY_RETRY_AFTER_SECONDS)
    ])
  })
})

describe('apiReadinessOnRequest', () => {
  let wikiHandle: { restore(): void } | undefined

  afterEach(() => {
    wikiHandle?.restore()
    wikiHandle = undefined
  })

  test('a ready instance falls through with no reply sent', async () => {
    wikiHandle = installTestWiki({ server: { isReady: () => true } })
    const { reply, calls } = makeReplyStub()

    await apiReadinessOnRequest({} as any, reply)

    assert.deepEqual(calls.serviceUnavailable, [])
  })

  test('a not-ready instance answers 503 through the same hook', async () => {
    wikiHandle = installTestWiki({ server: { isReady: () => false } })
    const { reply, calls } = makeReplyStub()

    await apiReadinessOnRequest({} as any, reply)

    assert.deepEqual(calls.serviceUnavailable, [API_NOT_READY_MESSAGE])
  })
})
