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
    // -> Stubbed to a public address by default so the SSRF guard (`assertNotPrivateAddress`) never
    //    blocks a test that isn't specifically exercising it, and so no test here makes a real DNS
    //    lookup. Individual tests below override this via `mock.method` again to exercise the guard
    //    itself.
    mock.method(liveData as any, 'resolveAddresses', async () => ['93.184.216.34'])
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

  test('throws Bad Request when the url resolves to a private address (SSRF guard)', async () => {
    mock.method(liveData as any, 'resolveAddresses', async () => ['169.254.169.254'])
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await assert.rejects(
      liveData.resolve('site-1', { url: 'https://metadata.internal/latest', jsonPath: '$.v' }),
      (err: any) => {
        assert.equal(err.statusCode, 400)
        return true
      }
    )
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test('does not fetch when only one of several resolved addresses is private', async () => {
    mock.method(liveData as any, 'resolveAddresses', async () => ['93.184.216.34', '127.0.0.1'])
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await assert.rejects(
      liveData.resolve('site-1', { url: 'https://example.com/metrics', jsonPath: '$.v' })
    )
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test('lets the fetch itself fail when the hostname cannot be resolved at all', async () => {
    mock.method(liveData as any, 'resolveAddresses', async () => {
      throw new Error('getaddrinfo ENOTFOUND nowhere.invalid')
    })
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('fetch failed')
    })
    await assert.rejects(
      liveData.resolve('site-1', { url: 'https://nowhere.invalid/metrics', jsonPath: '$.v' }),
      (err: any) => {
        assert.equal(err.statusCode, 502)
        return true
      }
    )
  })

  test('fetches with redirect: "error" -- a redirect is never followed', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await liveData.resolve('site-1', { url: 'https://example.com/metrics', jsonPath: '$.v' })
    const [, init]: [unknown, RequestInit] = fetchMock.mock.calls[0].arguments as any
    assert.equal(init.redirect, 'error')
  })

  test('throws Bad Gateway when the endpoint answers with a redirect', async () => {
    mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      if (init.redirect === 'error') {
        // -> What undici actually throws for a redirect response under `redirect: 'error'`.
        throw new TypeError('fetch failed')
      }
      throw new Error('should never fetch without redirect: "error"')
    })
    await assert.rejects(
      liveData.resolve('site-1', { url: 'https://example.com/metrics', jsonPath: '$.v' }),
      (err: any) => {
        assert.equal(err.statusCode, 502)
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
