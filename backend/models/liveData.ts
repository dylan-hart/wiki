import { createHash } from 'node:crypto'
import dns from 'node:dns/promises'
import type * as dnsTypes from 'node:dns'
import net from 'node:net'
import { Agent } from 'undici'
import { CustomError } from '../helpers/common.ts'
import { extractJsonPathValue } from '../helpers/jsonPath.ts'
import { isPrivateAddress, originMatchesAllowlist } from '../helpers/network.ts'
import type { RateLimitPolicy } from './rateLimits.ts'

export interface LiveDataRequest {
  /** A `blockCredentials` row id. Omitted (or empty) means the endpoint takes no auth header. */
  credentialId?: string | null
  url: string
  jsonPath: string
  /** Seconds. Clamped to {@link MIN_REFRESH_SECONDS}..{@link MAX_REFRESH_SECONDS}. */
  refreshInterval?: number
}

export interface LiveDataResult {
  value: unknown
  /** RFC 3339 instant this was actually fetched — the same for every request served from cache. */
  fetchedAt: string
}

/**
 * Not the author's to lower past: one fetch per site per cache window covers every reader with the
 * block open, and a window under ten seconds stops meaningfully protecting the upstream.
 */
const MIN_REFRESH_SECONDS = 10
const MAX_REFRESH_SECONDS = 24 * 60 * 60
const DEFAULT_REFRESH_SECONDS = 60

const FETCH_TIMEOUT_MS = 10000

const CACHE_PREFIX = 'liveData:'
const RATE_LIMIT_PREFIX = 'liveDataRate:'

/**
 * Per site rather than global: with no credential id to key off, several sites' authors polling
 * public endpoints would otherwise share one budget.
 */
function anonymousRateLimitKey(siteId: string): string {
  return `anon:${siteId}`
}

/**
 * Caps fresh (cache-miss) fetches attributable to one credential, whatever url/jsonPath each names.
 * The response cache only collapses repeats of the *same* request, so a caller who has learned a
 * credential's id — not a secret; it travels in page markdown as a block prop — could otherwise
 * vary the url or jsonPath every time to always miss it and force unthrottled outbound fetches for
 * as long as the allowlist accepts the url. The credential-free path shares the cap, keyed per site.
 *
 * Sized for legitimate multi-block use: several blocks may share one credential, each polling at the
 * {@link MIN_REFRESH_SECONDS} floor, so a dozen of them is already 72 fresh fetches a minute.
 */
const RATE_LIMIT_WINDOW_SECONDS = 60
const RATE_LIMIT_MAX_PER_WINDOW = 120
/** Equal to the window, so exceeding the cap costs the remainder of it rather than a brief pause. */
const RATE_LIMIT_POLICY: RateLimitPolicy = {
  max: RATE_LIMIT_MAX_PER_WINDOW,
  windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
  banSeconds: RATE_LIMIT_WINDOW_SECONDS
}

function clampRefreshSeconds(seconds: number | undefined): number {
  if (!Number.isFinite(seconds)) {
    return DEFAULT_REFRESH_SECONDS
  }
  return Math.min(Math.max(Math.floor(seconds as number), MIN_REFRESH_SECONDS), MAX_REFRESH_SECONDS)
}

/**
 * Hashed rather than concatenated raw: `url` and `jsonPath` are author-supplied and unbounded, so an
 * arbitrarily long request would otherwise grow the key without limit, evicting other entries this
 * same `CARDINAL.cache` instance holds.
 */
function buildCacheKey(
  siteId: string,
  credentialId: string | null | undefined,
  url: string,
  jsonPath: string
): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([url, jsonPath]))
    .digest('hex')
  return `${CACHE_PREFIX}${siteId}:${credentialId || ''}:${hash}`
}

/**
 * Resolves one `block-live-data` instance's data: an authenticated (or plain) GET against an
 * author-configured URL, narrowed to one field by JSONPath, cached for the author's refresh
 * interval. The ONLY place a `blockCredentials` secret is read back out and used — as a bearer token
 * on the one outbound request. `resolve()`'s result carries the extracted value and a timestamp and
 * nothing else, so a reader's browser never sees the credential that produced it.
 *
 * Four independent guards stand between a `write:pages` author and that secret, since `url` is just
 * a block prop:
 *
 * 1. **DNS pre-check** — the hostname is resolved up front and refused if any address is private,
 *    loopback or link-local. Without it, `write:pages` alone turns this into an SSRF proxy into the
 *    wiki's own network, optionally carrying a stored secret along.
 * 2. **`allowedOrigins`** — a credential may only be pointed at an origin and path prefix the admin
 *    who created it allowed, and only over `https:` whatever scheme an allowlist entry itself names.
 *    This is what stops an author exfiltrating a `manage:sites`-gated secret to a URL of their own.
 * 3. **Rate limit** — an allowlist narrows *where* a secret may be sent, not *how often*. Accounting
 *    runs only against a credential that has already passed guards 1 and 2, so an id resolving to
 *    nothing cannot burn down another credential's budget. See {@link RATE_LIMIT_MAX_PER_WINDOW}.
 * 4. **`CARDINAL.config.offline`** — checked after the cache lookup and before anything else on the
 *    fresh-fetch path, the DNS resolution included: an operator in offline mode expects nothing here
 *    to touch the network, not even to resolve a hostname. A cache hit is still served.
 */
class LiveData {
  async resolve(siteId: string, request: LiveDataRequest): Promise<LiveDataResult> {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      throw new CustomError('Bad Request', 'url must be a valid absolute URL.', 400)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new CustomError('Bad Request', 'url must be an http(s) address.', 400)
    }
    if (request.jsonPath.trim() === '$') {
      // -> A root selector returns the entire parsed upstream document, and `$` is the block's own
      //    default for this prop. Refusing it stops a host-level fetch allowance from doubling as a
      //    whole-document read primitive.
      throw new CustomError(
        'Bad Request',
        'jsonPath must not be a bare "$", which returns the entire response. Name a specific field, e.g. "$.data.value".',
        400
      )
    }

    const refreshSeconds = clampRefreshSeconds(request.refreshInterval)
    const cacheKey = buildCacheKey(siteId, request.credentialId, request.url, request.jsonPath)
    const cached = CARDINAL.cache.get(cacheKey) as LiveDataResult | undefined
    if (cached) {
      return cached
    }

    if (CARDINAL.config.offline) {
      throw new CustomError(
        'liveDataOffline',
        'Cardinal.js is in offline mode and cannot reach this endpoint to resolve live data.',
        503
      )
    }

    const validatedAddresses = await this.assertNotPrivateAddress(url)

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (request.credentialId) {
      const credential = await CARDINAL.models.blockCredentials.getCredentialForResolve(
        siteId,
        request.credentialId
      )
      if (credential === undefined) {
        throw new CustomError('Not Found', 'No such credential on this site.', 404)
      }
      // -> Before the allowlist, and unconditional: an `allowedOrigins` entry may itself be `http:`
      //    (schema-valid), but sending the secret in cleartext is never an admin's choice to make.
      if (url.protocol !== 'https:') {
        throw new CustomError('Bad Request', 'A credentialed request must use https.', 400)
      }
      if (!originMatchesAllowlist(url, credential.allowedOrigins)) {
        throw new CustomError(
          'Bad Request',
          "url is not within this credential's allowed origins.",
          400
        )
      }
      // -> Must stay after the allowlist and scheme checks, so an unresolvable or disallowed
      //    credentialId never consumes this credential's rate-limit budget.
      await this.assertWithinRateLimit(request.credentialId)
      headers.Authorization = `Bearer ${credential.secret}`
    } else {
      await this.assertWithinRateLimit(anonymousRateLimitKey(siteId))
    }

    const dispatcher = this.createPinnedDispatcher(validatedAddresses)
    try {
      let response: Response
      try {
        // -> `redirect: 'error'`, not the default `'follow'`: a redirect target is never run
        //    through `assertNotPrivateAddress`, so following one would hand the bearer token to
        //    whatever address the *response* names — the same SSRF hole, reopened one hop later.
        //    undici throws on it, which the catch below reports as any other network failure.
        // -> `dispatcher` is an undici extension to `fetch`'s options that Node's own (DOM-derived)
        //    `RequestInit` type does not declare, hence the cast.
        response = await fetch(url, {
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          dispatcher
        } as RequestInit & { dispatcher: Agent })
      } catch (err: any) {
        throw new CustomError('Bad Gateway', `Could not reach the endpoint: ${err.message}`, 502)
      }
      if (!response.ok) {
        throw new CustomError(
          'Bad Gateway',
          `The endpoint answered ${response.status} ${response.statusText}.`,
          502
        )
      }

      let json: unknown
      try {
        json = await response.json()
      } catch {
        throw new CustomError('Bad Gateway', 'The endpoint did not answer with valid JSON.', 502)
      }

      let value: unknown
      try {
        value = extractJsonPathValue(json, request.jsonPath)
      } catch (err: any) {
        throw new CustomError('Bad Request', err.message, 400)
      }

      const result: LiveDataResult = {
        value,
        fetchedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' })
      }
      CARDINAL.cache.set(cacheKey, result, { ttl: refreshSeconds * 1000 })
      return result
    } finally {
      await dispatcher.close()
    }
  }

  /**
   * `rateLimitKey` is a credential id, or {@link anonymousRateLimitKey}'s per-site key for a
   * credential-free request — each its own budget.
   *
   * Counted through `CARDINAL.models.rateLimits`, not `CARDINAL.cache`: a durable, postgres-backed
   * fixed-window counter is immune to cache eviction silently resetting a window mid-flight, and its
   * single atomic upsert makes one counter per credential correct across a cluster.
   */
  private async assertWithinRateLimit(rateLimitKey: string): Promise<void> {
    const verdict = await CARDINAL.models.rateLimits.consume(
      `${RATE_LIMIT_PREFIX}${rateLimitKey}`,
      RATE_LIMIT_POLICY
    )
    if (!verdict.allowed) {
      throw new CustomError(
        'Too Many Requests',
        'This endpoint is being fetched too frequently. Try again shortly.',
        429
      )
    }
  }

  /**
   * Fails closed: an unresolvable hostname is refused rather than left for the real fetch to fail
   * on. This lookup and undici's own are not guaranteed to agree, so a transient resolver failure
   * here followed by a successful resolution moments later would skip the check entirely — no
   * attacker-controlled DNS required.
   *
   * The returned addresses are what {@link createPinnedDispatcher} pins the connection to.
   */
  private async assertNotPrivateAddress(url: URL): Promise<string[]> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    let addresses: string[]
    try {
      addresses = await this.resolveAddresses(hostname)
    } catch (err: any) {
      throw new CustomError('Bad Request', `Could not resolve the endpoint: ${err.message}`, 400)
    }
    if (addresses.some((address) => isPrivateAddress(address))) {
      throw new CustomError(
        'Bad Request',
        'url resolves to a private, loopback, or link-local address, which this block may not fetch.',
        400
      )
    }
    return addresses
  }

  /** Broken out so a test can mock it rather than making a real DNS lookup. */
  private async resolveAddresses(hostname: string): Promise<string[]> {
    const results = await dns.lookup(hostname, { all: true })
    return results.map((result) => result.address)
  }

  /**
   * A per-request undici `Agent` whose `connect.lookup` returns only the addresses
   * `assertNotPrivateAddress` validated, never resolving the hostname again.
   *
   * Otherwise undici would resolve the hostname itself — a second, independent lookup with no
   * connection to the validated one. A nameserver an attacker controls can answer the pre-check with
   * a public address and that one with a private address (TTL-0 DNS rebinding); pinning closes the
   * gap by making a second lookup never happen.
   */
  private createPinnedDispatcher(validatedAddresses: string[]): Agent {
    return new Agent({ connect: { lookup: this.createPinnedLookup(validatedAddresses) } })
  }

  /**
   * Broken out from {@link createPinnedDispatcher} so a test can drive the callback without reaching
   * into an undici `Agent`'s internals. Ignores the hostname it is asked about entirely: it never
   * performs a real lookup, only ever hands back a subset of the addresses it was built with.
   */
  private createPinnedLookup(validatedAddresses: string[]) {
    const byFamily = validatedAddresses
      .map((address) => ({ address, family: net.isIP(address) }))
      .filter((entry) => entry.family !== 0)
    return (
      _hostname: string,
      options: dnsTypes.LookupOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        address: string | dnsTypes.LookupAddress[],
        family?: number
      ) => void
    ) => {
      const wantedFamily =
        options.family === 'IPv6' ? 6 : options.family === 'IPv4' ? 4 : (options.family ?? 0)
      const matches = byFamily.filter(
        (entry) => wantedFamily === 0 || entry.family === wantedFamily
      )
      if (matches.length === 0) {
        callback(
          Object.assign(new Error('No pre-validated address available for this connection.'), {
            code: 'ENOTFOUND'
          }),
          ''
        )
        return
      }
      if (options.all) {
        callback(
          null,
          matches.map((entry) => ({ address: entry.address, family: entry.family }))
        )
      } else {
        callback(null, matches[0].address, matches[0].family)
      }
    }
  }
}

export const liveData = new LiveData()
