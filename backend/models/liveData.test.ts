import { afterEach, beforeEach, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCacheStub } from '../test/mocks.ts'
import { liveData } from './liveData.ts'

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'OK',
    json: async () => body
  } as Response
}

describe('LiveData.resolve', () => {
  let getSecret: ReturnType<typeof mock.fn>

  before(async () => {
    // -> Node 25 (this sandbox) has no native `Temporal` yet — Node 26 does, per this repo's engine
    //    requirement. Polyfilled only when missing, so this is a no-op on a real Node 26 runtime —
    //    same pattern as `models/storage.test.ts`'s own `before()`.
    if (typeof Temporal === 'undefined') {
      const polyfill = await import('@js-temporal/polyfill')
      ;(globalThis as any).Temporal = polyfill.Temporal
    }
    ;(globalThis as any).WIKI = {
      cache: createCacheStub(),
      models: {
        blockCredentials: {
          getSecret: mock.fn(async () => undefined)
        }
      }
    }
  })

  beforeEach(() => {
    getSecret = mock.fn(async () => undefined)
    ;(WIKI.models.blockCredentials.getSecret as any) = getSecret
  })

  afterEach(() => {
    mock.restoreAll()
    ;(WIKI.cache as any).flushAll()
  })

  test('extracts the JSONPath value from a plain (no-credential) endpoint', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ status: 'ok', cpu: 17 }))
    const result = await liveData.resolve('site-1', {
      url: 'https://example.com/metrics',
      jsonPath: '$.cpu'
    })
    assert.equal(result.value, 17)
    assert.match(result.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
  })

  test('resolves the credential and sends it as a bearer token', async () => {
    getSecret.mock.mockImplementation(async () => 's3cr3t-token')
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await liveData.resolve('site-1', {
      credentialId: 'cred-1',
      url: 'https://example.com/metrics',
      jsonPath: '$.v'
    })
    const [, init]: [unknown, { headers: Record<string, string> }] = fetchMock.mock.calls[0]
      .arguments as any
    assert.equal(init.headers.Authorization, 'Bearer s3cr3t-token')
  })

  test('never puts the credential secret into the resolved result', async () => {
    getSecret.mock.mockImplementation(async () => 's3cr3t-token')
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    const result = await liveData.resolve('site-1', {
      credentialId: 'cred-1',
      url: 'https://example.com/metrics',
      jsonPath: '$.v'
    })
    assert.equal(JSON.stringify(result).includes('s3cr3t-token'), false)
  })

  test('throws Not Found for a credential id with no matching row on this site', async () => {
    getSecret.mock.mockImplementation(async () => undefined)
    await assert.rejects(
      liveData.resolve('site-1', {
        credentialId: 'missing',
        url: 'https://example.com/metrics',
        jsonPath: '$.v'
      }),
      (err: any) => {
        assert.equal(err.statusCode, 404)
        return true
      }
    )
  })

  test('throws Bad Request for a malformed url', async () => {
    await assert.rejects(
      liveData.resolve('site-1', { url: 'not-a-url', jsonPath: '$.v' }),
      (err: any) => {
        assert.equal(err.statusCode, 400)
        return true
      }
    )
  })

  test('throws Bad Gateway for a non-2xx response', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({}, { ok: false, status: 503 }))
    await assert.rejects(
      liveData.resolve('site-1', { url: 'https://example.com/metrics', jsonPath: '$.v' }),
      (err: any) => {
        assert.equal(err.statusCode, 502)
        return true
      }
    )
  })

  test('throws Bad Request for a JSONPath that matches nothing', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await assert.rejects(
      liveData.resolve('site-1', { url: 'https://example.com/metrics', jsonPath: '$.missing' }),
      (err: any) => {
        assert.equal(err.statusCode, 400)
        return true
      }
    )
  })

  test('serves a repeat request for the same query from cache without a second fetch', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 42 }))
    const request = { url: 'https://example.com/metrics', jsonPath: '$.v', refreshInterval: 60 }
    const first = await liveData.resolve('site-1', request)
    const second = await liveData.resolve('site-1', request)
    assert.equal(fetchMock.mock.calls.length, 1)
    assert.deepEqual(second, first)
  })

  test('does not share a cache entry across sites or across differing JSONPaths', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 42, w: 43 }))
    await liveData.resolve('site-1', { url: 'https://example.com/metrics', jsonPath: '$.v' })
    await liveData.resolve('site-2', { url: 'https://example.com/metrics', jsonPath: '$.v' })
    await liveData.resolve('site-1', { url: 'https://example.com/metrics', jsonPath: '$.w' })
    assert.equal(fetchMock.mock.calls.length, 3)
  })

  test('clamps a refreshInterval below the floor when writing to the cache', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await liveData.resolve('site-1', {
      url: 'https://example.com/metrics',
      jsonPath: '$.v',
      refreshInterval: 1
    })
    const setCall = (WIKI.cache.set as any).mock.calls.at(-1)
    assert.equal(setCall.arguments[2], 10)
  })
})
