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

/**
 * A minimal `WIKI.models.rateLimits`-shaped stand-in for `assertWithinRateLimit`'s durable limiter
 * (OpenProject #1700) — a real Map, deliberately NOT `WIKI.cache`, so a test can prove the rate-limit
 * window survives cache churn (clears, evictions) rather than sharing storage with it the way the old
 * LRU-backed counter did. Mirrors `models/rateLimits.ts#consume()`'s fixed-window-plus-ban semantics
 * closely enough for this model's purposes (`models/hooks.test.ts`'s `createFakeRateLimits` is the
 * sibling stub for the webhook path, minus the ban half this one also needs).
 */
function createFakeRateLimits() {
  const store = new Map<string, { windowStart: number; hits: number; bannedUntil: number }>()
  return {
    consume: async (
      key: string,
      policy: { max: number; windowSeconds: number; banSeconds: number }
    ) => {
      const now = Date.now()
      let entry = store.get(key)
      if (entry && entry.bannedUntil > now) {
        return {
          allowed: false,
          hits: entry.hits,
          retryAfter: Math.max(1, Math.ceil((entry.bannedUntil - now) / 1000))
        }
      }
      if (!entry || now - entry.windowStart >= policy.windowSeconds * 1000) {
        entry = { windowStart: now, hits: 0, bannedUntil: 0 }
      }
      entry.hits++
      const overCap = entry.hits > policy.max
      if (overCap) {
        entry.bannedUntil = now + policy.banSeconds * 1000
      }
      store.set(key, entry)
      return { allowed: !overCap, hits: entry.hits, retryAfter: overCap ? policy.banSeconds : 0 }
    },
    clear: () => store.clear()
  }
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
      models: {
        blockCredentials: {
          getCredentialForResolve: mock.fn(async () => undefined)
        },
        rateLimits: createFakeRateLimits()
      }
    }
  })

  beforeEach(() => {
    getCredentialForResolve = mock.fn(async () => undefined)
    ;(WIKI.models.blockCredentials.getCredentialForResolve as any) = getCredentialForResolve
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
      allowedDomains: ['example.com']
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
      allowedDomains: ['example.com']
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

  test("throws Bad Request when the url is not in the credential's allowed domains", async () => {
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedDomains: ['other.com']
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
      allowedDomains: ['other.com']
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
      allowedDomains: ['*.example.com']
    }))
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    const result = await liveData.resolve('site-1', {
      credentialId: 'cred-1',
      url: 'https://api.example.com/metrics',
      jsonPath: '$.v'
    })
    assert.equal(result.value, 1)
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
    assert.equal(setCall.arguments[2].ttl, 10 * 1000)
  })
})

describe('LiveData.resolve rate limiting (OpenProject #1050)', () => {
  let getCredentialForResolve: ReturnType<typeof mock.fn>

  beforeEach(() => {
    getCredentialForResolve = mock.fn(async () => ({
      secret: 's3cr3t-token',
      allowedDomains: ['example.com']
    }))
    ;(WIKI.models.blockCredentials.getCredentialForResolve as any) = getCredentialForResolve
    mock.method(liveData as any, 'resolveAddresses', async () => ['93.184.216.34'])
  })

  afterEach(() => {
    mock.restoreAll()
    ;(WIKI.cache as any).clear()
    ;(WIKI.models.rateLimits as any).clear()
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

  test('a request with no credentialId is never rate limited', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    for (let i = 0; i < 150; i++) {
      await liveData.resolve('site-1', {
        url: `https://example.com/metrics?i=${i}`,
        jsonPath: '$.v'
      })
    }
    assert.equal(getCredentialForResolve.mock.calls.length, 0)
  })

  test('filling WIKI.cache between calls does not reset the credential window (OpenProject #1700)', async () => {
    // -> The rate-limit counter used to live in `WIKI.cache` alongside the response cache, so ordinary
    //    cache churn (capacity eviction of the counter's own key) could silently reset a credential's
    //    window. It now lives in `WIKI.models.rateLimits` instead (a real durable store; `createFakeRateLimits`
    //    stands in for it here) — clearing `WIKI.cache` between requests, simulating that churn, must
    //    have no effect on the counter.
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await exhaust('cred-rate-6', 120)
    // -> Simulates the response cache (and every other unrelated WIKI.cache key) being evicted or
    //    flushed between requests -- the exact scenario that used to reset this credential's rate-limit
    //    window when the counter shared that cache.
    ;(WIKI.cache as any).clear()
    await assert.rejects(
      liveData.resolve('site-1', {
        credentialId: 'cred-rate-6',
        url: 'https://example.com/metrics?i=after-cache-clear',
        jsonPath: '$.v'
      }),
      (err: any) => {
        assert.equal(err.statusCode, 429)
        return true
      }
    )
  })
})
