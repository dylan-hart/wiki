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
  let getCredentialForResolve: ReturnType<typeof mock.fn>

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
      config: { offline: false },
      models: {
        blockCredentials: {
          getCredentialForResolve: mock.fn(async () => undefined)
        }
      }
    }
  })

  beforeEach(() => {
    getCredentialForResolve = mock.fn(async () => undefined)
    ;(WIKI.models.blockCredentials.getCredentialForResolve as any) = getCredentialForResolve
    WIKI.config.offline = false
    // -> Stubbed to a public address by default so the SSRF guard (`assertNotPrivateAddress`) never
    //    blocks a test that isn't specifically exercising it, and so no test here makes a real DNS
    //    lookup. Individual tests below override this via `mock.method` again to exercise the guard
    //    itself.
    mock.method(liveData as any, 'resolveAddresses', async () => ['93.184.216.34'])
  })

  afterEach(() => {
    mock.restoreAll()
    ;(WIKI.cache as any).clear()
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
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedOrigins: ['https://example.com']
    }))
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
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedOrigins: ['https://example.com']
    }))
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    const result = await liveData.resolve('site-1', {
      credentialId: 'cred-1',
      url: 'https://example.com/metrics',
      jsonPath: '$.v'
    })
    assert.equal(JSON.stringify(result).includes('s3cr3t-token'), false)
  })

  test('throws Not Found for a credential id with no matching row on this site', async () => {
    getCredentialForResolve.mock.mockImplementation(async () => undefined)
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

  test("throws Bad Request when the url is not in the credential's allowed origins", async () => {
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedOrigins: ['https://other.com']
    }))
    await assert.rejects(
      liveData.resolve('site-1', {
        credentialId: 'cred-1',
        url: 'https://example.com/metrics',
        jsonPath: '$.v'
      }),
      (err: any) => {
        assert.equal(err.statusCode, 400)
        return true
      }
    )
  })

  test('does not call fetch when the url is outside the allowlist', async () => {
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedOrigins: ['https://other.com']
    }))
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await assert.rejects(
      liveData.resolve('site-1', {
        credentialId: 'cred-1',
        url: 'https://example.com/metrics',
        jsonPath: '$.v'
      })
    )
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test('allows the url when it matches a wildcard entry in the allowlist', async () => {
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedOrigins: ['https://*.example.com']
    }))
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    const result = await liveData.resolve('site-1', {
      credentialId: 'cred-1',
      url: 'https://api.example.com/metrics',
      jsonPath: '$.v'
    })
    assert.equal(result.value, 1)
  })

  test("throws Bad Request when the url is outside the credential's allowed path prefix", async () => {
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedOrigins: ['https://example.com/v1']
    }))
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await assert.rejects(
      liveData.resolve('site-1', {
        credentialId: 'cred-1',
        url: 'https://example.com/v2/metrics',
        jsonPath: '$.v'
      }),
      (err: any) => {
        assert.equal(err.statusCode, 400)
        return true
      }
    )
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test('succeeds against a url within the allowed path prefix', async () => {
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedOrigins: ['https://example.com/v1']
    }))
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    const result = await liveData.resolve('site-1', {
      credentialId: 'cred-1',
      url: 'https://example.com/v1/metrics',
      jsonPath: '$.v'
    })
    assert.equal(result.value, 1)
  })

  test('refuses a credentialed request over http, even when the allowlist would otherwise match', async () => {
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedOrigins: ['http://example.com']
    }))
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await assert.rejects(
      liveData.resolve('site-1', {
        credentialId: 'cred-1',
        url: 'http://example.com/metrics',
        jsonPath: '$.v'
      }),
      (err: any) => {
        assert.equal(err.statusCode, 400)
        return true
      }
    )
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test('a request with no credentialId is never checked against any allowlist', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ cpu: 5 }))
    const result = await liveData.resolve('site-1', {
      url: 'https://anything.example.net/metrics',
      jsonPath: '$.cpu'
    })
    assert.equal(result.value, 5)
    assert.equal(getCredentialForResolve.mock.calls.length, 0)
  })

  test('a request with no credentialId is allowed over plain http', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ cpu: 5 }))
    const result = await liveData.resolve('site-1', {
      url: 'http://anything.example.net/metrics',
      jsonPath: '$.cpu'
    })
    assert.equal(result.value, 5)
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

  test('throws Bad Request for a bare "$" jsonPath', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await assert.rejects(
      liveData.resolve('site-1', { url: 'https://example.com/metrics', jsonPath: '$' }),
      (err: any) => {
        assert.equal(err.statusCode, 400)
        return true
      }
    )
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test('throws Bad Request for a whitespace-padded bare "$" jsonPath', async () => {
    await assert.rejects(
      liveData.resolve('site-1', { url: 'https://example.com/metrics', jsonPath: '  $  ' }),
      (err: any) => {
        assert.equal(err.statusCode, 400)
        return true
      }
    )
  })

  test('a jsonPath narrower than a bare "$" (e.g. "$.v") is accepted', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 9 }))
    const result = await liveData.resolve('site-1', {
      url: 'https://example.com/metrics',
      jsonPath: '$.v'
    })
    assert.equal(result.value, 9)
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

  test('fails closed with Bad Request (not an unchecked fetch) when the DNS pre-check throws (OpenProject #2239)', async () => {
    mock.method(liveData as any, 'resolveAddresses', async () => {
      throw new Error('getaddrinfo ENOTFOUND nowhere.invalid')
    })
    const fetchMock = mock.method(globalThis, 'fetch', async () => {
      throw new Error('should never be called -- the pre-check must refuse before any fetch')
    })
    await assert.rejects(
      liveData.resolve('site-1', { url: 'https://nowhere.invalid/metrics', jsonPath: '$.v' }),
      (err: any) => {
        assert.equal(err.statusCode, 400)
        return true
      }
    )
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test('dispatches the fetch through a pinned undici Agent built from the pre-validated addresses (OpenProject #2241)', async () => {
    mock.method(liveData as any, 'resolveAddresses', async () => ['93.184.216.34'])
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await liveData.resolve('site-1', { url: 'https://example.com/metrics', jsonPath: '$.v' })
    const [, init]: [unknown, { dispatcher: any }] = fetchMock.mock.calls[0].arguments as any
    assert.equal(init.dispatcher?.constructor?.name, 'Agent')
  })

  test("the pinned dispatcher's connector never falls back to a real lookup, and returns only the pre-validated address (OpenProject #2241)", async () => {
    const lookup = (liveData as any).createPinnedLookup(['93.184.216.34'])
    // -> Whatever hostname is actually being connected to -- including one that would resolve
    //    differently by now than it did at the pre-check (DNS rebinding) -- the connector must still
    //    only ever hand back the address the pre-check already validated, never perform a fresh lookup.
    const result = await new Promise((resolve) => {
      lookup(
        'attacker-controlled.example',
        { family: 0, all: false },
        (err: Error | null, address: string) => resolve({ err, address })
      )
    })
    assert.deepEqual(result, { err: null, address: '93.184.216.34' })
  })

  test("the pinned dispatcher's connector refuses when no pre-validated address matches the requested family", async () => {
    const lookup = (liveData as any).createPinnedLookup(['93.184.216.34']) // IPv4 only
    const result = await new Promise((resolve) => {
      lookup('example.com', { family: 6, all: false }, (err: Error | null, address: string) => {
        resolve({ err, address })
      })
    })
    assert.equal((result as any).err instanceof Error, true)
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
    assert.equal(setCall.arguments[2].ttl, 10 * 1000)
  })

  test('the cache key stays a bounded length no matter how long the url is (OpenProject #2185)', async () => {
    const cacheSetMock = WIKI.cache.set as any
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    const longUrl = `https://example.com/metrics?${'a'.repeat(10000)}`
    await liveData.resolve('site-1', { url: longUrl, jsonPath: '$.v' })
    const key = cacheSetMock.mock.calls.at(-1).arguments[0] as string
    assert.ok(key.length < 200, `expected a bounded cache key, got length ${key.length}`)
  })

  test('a repeat request with a very long, identical url still serves from cache', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    const request = {
      url: `https://example.com/metrics?${'b'.repeat(5000)}`,
      jsonPath: '$.v',
      refreshInterval: 60
    }
    await liveData.resolve('site-1', request)
    await liveData.resolve('site-1', request)
    assert.equal(fetchMock.mock.calls.length, 1)
  })

  test('refuses to fetch when the instance is in offline mode', async () => {
    WIKI.config.offline = true
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await assert.rejects(
      liveData.resolve('site-1', { url: 'https://example.com/metrics', jsonPath: '$.v' }),
      (err: any) => {
        assert.equal(err.statusCode, 503)
        return true
      }
    )
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test('still serves a cached value while the instance is in offline mode', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 7 }))
    const request = { url: 'https://example.com/metrics', jsonPath: '$.v', refreshInterval: 60 }
    const first = await liveData.resolve('site-1', request)
    WIKI.config.offline = true
    const second = await liveData.resolve('site-1', request)
    assert.deepEqual(second, first)
  })
})

describe('LiveData.resolve rate limiting (OpenProject #1050, #2185)', () => {
  let getCredentialForResolve: ReturnType<typeof mock.fn>

  beforeEach(() => {
    getCredentialForResolve = mock.fn(async () => ({
      secret: 's3cr3t-token',
      allowedOrigins: ['https://example.com']
    }))
    ;(WIKI.models.blockCredentials.getCredentialForResolve as any) = getCredentialForResolve
    WIKI.config.offline = false
    mock.method(liveData as any, 'resolveAddresses', async () => ['93.184.216.34'])
  })

  afterEach(() => {
    mock.restoreAll()
    ;(WIKI.cache as any).clear()
  })

  /** Exhausts a credential's per-window cap, always missing the response cache (a distinct url each
   *  time), so `count` fresh fetches actually go out. */
  async function exhaust(credentialId: string, count: number) {
    for (let i = 0; i < count; i++) {
      await liveData.resolve('site-1', {
        credentialId,
        url: `https://example.com/metrics?i=${i}`,
        jsonPath: '$.v'
      })
    }
  }

  test('allows up to the per-credential cap of fresh fetches within one window', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await assert.doesNotReject(exhaust('cred-rate-1', 120))
  })

  test('throws Too Many Requests once a credential exceeds its fresh-fetch rate limit', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await exhaust('cred-rate-2', 120)
    await assert.rejects(
      liveData.resolve('site-1', {
        credentialId: 'cred-rate-2',
        url: 'https://example.com/metrics?i=over',
        jsonPath: '$.v'
      }),
      (err: any) => {
        assert.equal(err.statusCode, 429)
        return true
      }
    )
  })

  test('does not call fetch once the rate limit is exceeded', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await exhaust('cred-rate-3', 120)
    const callsBefore = fetchMock.mock.calls.length
    await assert.rejects(
      liveData.resolve('site-1', {
        credentialId: 'cred-rate-3',
        url: 'https://example.com/metrics?i=over',
        jsonPath: '$.v'
      })
    )
    assert.equal(fetchMock.mock.calls.length, callsBefore)
  })

  test('a cache hit (repeat identical request) does not count against the rate limit', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    const request = {
      credentialId: 'cred-rate-4',
      url: 'https://example.com/metrics',
      jsonPath: '$.v',
      refreshInterval: 60
    }
    for (let i = 0; i < 200; i++) {
      await liveData.resolve('site-1', request)
    }
    assert.equal(fetchMock.mock.calls.length, 1)
  })

  test('a different credential has an independent rate limit', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await exhaust('cred-rate-5a', 120)
    const result = await liveData.resolve('site-1', {
      credentialId: 'cred-rate-5b',
      url: 'https://example.com/metrics?fresh=1',
      jsonPath: '$.v'
    })
    assert.equal(result.value, 1)
  })

  test('an unresolvable credentialId consumes no rate-limit budget (OpenProject #2185)', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    // -> 200 attempts against a credential id that never resolves -- well past the 120/window cap --
    //    followed by a real, valid credential that must still have its full budget available.
    getCredentialForResolve.mock.mockImplementation(async () => undefined)
    for (let i = 0; i < 200; i++) {
      await assert.rejects(
        liveData.resolve('site-1', {
          credentialId: 'cred-rate-unresolvable',
          url: `https://example.com/metrics?i=${i}`,
          jsonPath: '$.v'
        }),
        (err: any) => {
          assert.equal(err.statusCode, 404)
          return true
        }
      )
    }
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedOrigins: ['https://example.com']
    }))
    await assert.doesNotReject(exhaust('cred-rate-unresolvable', 120))
  })

  test('an off-allowlist url consumes no rate-limit budget', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedOrigins: ['https://other.com']
    }))
    for (let i = 0; i < 130; i++) {
      await assert.rejects(
        liveData.resolve('site-1', {
          credentialId: 'cred-rate-disallowed',
          url: `https://example.com/metrics?i=${i}`,
          jsonPath: '$.v'
        })
      )
    }
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedOrigins: ['https://example.com']
    }))
    const result = await liveData.resolve('site-1', {
      credentialId: 'cred-rate-disallowed',
      url: 'https://example.com/metrics?fresh=1',
      jsonPath: '$.v'
    })
    assert.equal(result.value, 1)
  })

  test('a request with no credentialId is metered per site, independent of credentialed requests', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    for (let i = 0; i < 120; i++) {
      await liveData.resolve('site-1', {
        url: `https://example.com/metrics?i=${i}`,
        jsonPath: '$.v'
      })
    }
    assert.equal(getCredentialForResolve.mock.calls.length, 0)
    await assert.rejects(
      liveData.resolve('site-1', {
        url: 'https://example.com/metrics?i=over',
        jsonPath: '$.v'
      }),
      (err: any) => {
        assert.equal(err.statusCode, 429)
        return true
      }
    )
  })

  test('a credential-free rate limit on one site does not affect another site', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    for (let i = 0; i < 120; i++) {
      await liveData.resolve('site-1', {
        url: `https://example.com/metrics?i=${i}`,
        jsonPath: '$.v'
      })
    }
    const result = await liveData.resolve('site-2', {
      url: 'https://example.com/metrics?fresh=1',
      jsonPath: '$.v'
    })
    assert.equal(result.value, 1)
  })
})
