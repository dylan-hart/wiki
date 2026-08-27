import dns from 'node:dns/promises'
import { CustomError } from '../helpers/common.ts'
import { extractJsonPathValue } from '../helpers/jsonPath.ts'
import { hostnameMatchesAllowlist, isPrivateAddress } from '../helpers/network.ts'
import type { RateLimitPolicy } from './rateLimits.ts'

/** A `block-live-data` instance's props, as posted to the resolve route. */
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
 * Floor on the cache TTL an author's `refreshInterval` is clamped to.
 *
 * Not the author's to lower past this: the endpoint is fetched once per site per cache window no
 * matter how many readers have the block open, but a window under ten seconds stops meaningfully
 * protecting the upstream from a page with several readers on it at once.
 */
const MIN_REFRESH_SECONDS = 10
const MAX_REFRESH_SECONDS = 24 * 60 * 60
const DEFAULT_REFRESH_SECONDS = 60

/** How long the upstream request is allowed to hang before this gives up on it. */
const FETCH_TIMEOUT_MS = 10000

const CACHE_PREFIX = 'liveData:'
const RATE_LIMIT_PREFIX = 'liveDataRate:'

/**
 * The per-credential fresh-fetch rate limit window and cap (OpenProject #1050).
 *
 * The response cache already collapses repeat requests for the *same* site/credential/url/jsonPath
 * onto one upstream fetch per `refreshInterval` — but nothing stopped a caller who has merely learned
 * a credential's id (its allowed domains are not a secret — every admin managing the site can see
 * them, and the id itself travels in plain page markdown as a block prop, readable by anyone with
 * `read:source`) from varying the url or jsonPath on every request to always miss that cache and
 * force a fresh outbound fetch, unthrottled, for as long as the credential's domain allowlist would
 * accept the url. This caps *that*: total fresh (cache-miss) fetches attributable to one credential,
 * independent of which url/jsonPath each one names.
 *
 * The cap is sized for legitimate multi-block use, not just one: several distinct `block-live-data`
 * instances can share one credential, each polling its own url/jsonPath as often as the
 * {@link MIN_REFRESH_SECONDS} floor allows -- a dozen such blocks at that floor is already 72
 * fresh fetches/minute. 120/minute leaves headroom above that while still bounding a caller that is
 * deliberately varying the request to bypass the response cache.
 *
 * Counted via `WIKI.models.rateLimits.consume` (OpenProject #1700) rather than `WIKI.cache`: the
 * counter used to live in the same LRU the response cache, the glossary term map and the locale list
 * all share, so ordinary cache traffic could evict a credential's counter mid-window and silently
 * reset its count. `consume` is durable and keyed per credential, independent of both cache churn and
 * which backend instance in a cluster happens to handle the request -- see `models/rateLimits.ts`.
 */
const RATE_LIMIT_WINDOW_SECONDS = 60
const RATE_LIMIT_MAX_PER_WINDOW = 120
/**
 * How long a credential stays refused once it exceeds {@link RATE_LIMIT_MAX_PER_WINDOW} in one
 * window. Set equal to the window itself: the old cache-backed counter kept incrementing (and
 * throwing) on every request until its window's TTL lapsed, so a ban lasting one full window
 * reproduces that behavior rather than granting an early reprieve.
 */
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
 * Live data model (OpenProject #868)
 *
 * Resolves one `block-live-data` instance's data: an authenticated (or plain) GET against an
 * author-configured URL, narrowed to one field by JSONPath, cached for the author's refresh
 * interval. This is the ONLY place the secret a `blockCredentials` row holds is ever read back out
 * and put to use — as a bearer token on the one outbound request, never returned to the caller.
 *
 * Runs entirely server-side, on the wiki's own connection to the endpoint: `resolve()`'s result never
 * carries anything but the extracted value and when it was fetched, so a reader's browser (and the
 * page's own source, for that matter — this never touches page content) never sees the credential
 * that produced it.
 *
 * `url` is author-supplied (a block prop, gated only by `write:pages` — see `helpers/network.ts`'s
 * header comment), so before ever fetching it this resolves the hostname and refuses to proceed if
 * any resolved address is private, loopback, or link-local: otherwise `write:pages` alone would let
 * an author turn this into an SSRF proxy into the wiki's own network, optionally carrying a stored
 * credential's secret along with it.
 *
 * A credential's `allowedDomains` is a second, independent guard, checked once a `credentialId` is
 * given: even an author who legitimately knows a credential's id may not point it at any URL — only
 * ones the admin who created that credential explicitly allowed. This is what stops a `write:pages`
 * author from exfiltrating a `manage:sites`-gated secret to a URL of their own choosing.
 *
 * A per-credential rate limit is a third, independent guard (OpenProject #1050): the resolve route
 * this backs is deliberately unauthenticated (see `api/liveData.ts`'s header comment), and a
 * credential's allowlist narrows *where* its secret may be sent but not *how often* — without this, a
 * caller who has merely learned a credential's id could vary the url/jsonPath on every request to
 * bypass the response cache and drive unlimited fresh fetches against whatever the allowed domain
 * hosts. See {@link RATE_LIMIT_MAX_PER_WINDOW}.
 */
class LiveData {
  /**
   * @throws {CustomError} `Bad Request` (400) for a malformed URL/JSONPath, an unmatched JSONPath, a
   *   URL resolving to a private/loopback/link-local address, or a URL outside a given credential's
   *   allowed domains, `Not Found` (404) for a `credentialId` with no matching row on this site,
   *   `Too Many Requests` (429) once a credential has exceeded its fresh-fetch rate limit,
   *   `Bad Gateway` (502) for a network failure, a non-2xx response, or a response body that isn't
   *   JSON.
   */
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

    const refreshSeconds = clampRefreshSeconds(request.refreshInterval)
    const cacheKey = `${CACHE_PREFIX}${siteId}:${request.credentialId || ''}:${request.url}:${request.jsonPath}`
    const cached = WIKI.cache.get(cacheKey) as LiveDataResult | undefined
    if (cached) {
      return cached
    }

    await this.assertNotPrivateAddress(url)

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (request.credentialId) {
      await this.assertWithinRateLimit(request.credentialId)
      const credential = await WIKI.models.blockCredentials.getCredentialForResolve(
        siteId,
        request.credentialId
      )
      if (credential === undefined) {
        throw new CustomError('Not Found', 'No such credential on this site.', 404)
      }
      if (!hostnameMatchesAllowlist(url.hostname, credential.allowedDomains)) {
        throw new CustomError(
          'Bad Request',
          "url is not in this credential's allowed domains.",
          400
        )
      }
      headers.Authorization = `Bearer ${credential.secret}`
    }

    let response: Response
    try {
      // -> `redirect: 'error'` rather than the default `'follow'`: a redirect response is never
      //    resolved by `assertNotPrivateAddress` above, so following one would hand the credential's
      //    bearer token (and the DNS check itself) to whatever address the *response* names instead of
      //    the one the author configured — the same SSRF hole the pre-check exists to close, reopened
      //    one hop later. A malformed or unreachable-by-design redirect target throws here, which the
      //    catch below reports as the same `Bad Gateway` any other network failure gets.
      response = await fetch(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
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
    WIKI.cache.set(cacheKey, result, { ttl: refreshSeconds * 1000 })
    return result
  }

  /**
   * Counts this fresh (cache-miss) fetch against `credentialId`'s rate limit and throws once the
   * window's cap is exceeded — see the class comment and {@link RATE_LIMIT_MAX_PER_WINDOW}.
   *
   * Delegates to `WIKI.models.rateLimits.consume` (OpenProject #1700) — the same durable,
   * postgres-backed fixed-window limiter `models/hooks.ts#emit()` uses for webhook delivery — rather
   * than counting in `WIKI.cache`. A single upsert reads, rolls over, increments and possibly bans the
   * row atomically, so this is also safe across a cluster of backend instances sharing one counter per
   * credential, not just within one process.
   *
   * @throws {CustomError} `Too Many Requests` (429) once the count exceeds the cap.
   */
  private async assertWithinRateLimit(credentialId: string): Promise<void> {
    const verdict = await WIKI.models.rateLimits.consume(
      `${RATE_LIMIT_PREFIX}${credentialId}`,
      RATE_LIMIT_POLICY
    )
    if (!verdict.allowed) {
      throw new CustomError(
        'Too Many Requests',
        'This credential is being used to fetch too frequently. Try again shortly.',
        429
      )
    }
  }

  /**
   * Resolves `url`'s hostname and refuses to continue if any address it comes back with is private,
   * loopback, or link-local — see the class comment. A hostname that fails to resolve at all is left
   * for the real fetch to fail on its own (a `Bad Gateway`), rather than duplicated here.
   *
   * @throws {CustomError} `Bad Request` (400) when any resolved address is non-public.
   */
  private async assertNotPrivateAddress(url: URL): Promise<void> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    let addresses: string[]
    try {
      addresses = await this.resolveAddresses(hostname)
    } catch {
      return
    }
    if (addresses.some((address) => isPrivateAddress(address))) {
      throw new CustomError(
        'Bad Request',
        'url resolves to a private, loopback, or link-local address, which this block may not fetch.',
        400
      )
    }
  }

  /** Broken out so a test can mock it — the same pattern `diagramRender.ts#launchBrowser` uses. */
  private async resolveAddresses(hostname: string): Promise<string[]> {
    const results = await dns.lookup(hostname, { all: true })
    return results.map((result) => result.address)
  }
}

export const liveData = new LiveData()
