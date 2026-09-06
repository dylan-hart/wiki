import { createHash } from 'node:crypto'
import dns from 'node:dns/promises'
import type * as dnsTypes from 'node:dns'
import net from 'node:net'
import { Agent } from 'undici'
import { CustomError } from '../helpers/common.ts'
import { extractJsonPathValue } from '../helpers/jsonPath.ts'
import { isPrivateAddress, originMatchesAllowlist } from '../helpers/network.ts'
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
 * The rate-limit key an uncredentialed resolve is metered under, scoped per site rather than
 * globally: several sites' authors independently polling public endpoints shouldn't share one
 * budget, but there is no credential id to key off for this path (OpenProject #2185 — this path used
 * to skip the limiter entirely).
 */
function anonymousRateLimitKey(siteId: string): string {
  return `anon:${siteId}`
}

/**
 * The per-credential fresh-fetch rate limit window and cap (OpenProject #1050).
 *
 * The response cache already collapses repeat requests for the *same* site/credential/url/jsonPath
 * onto one upstream fetch per `refreshInterval` — but nothing stopped a caller who has merely learned
 * a credential's id (its allowed origins are not a secret — every admin managing the site can see
 * them, and the id itself travels in plain page markdown as a block prop, readable by anyone with
 * `read:source`) from varying the url or jsonPath on every request to always miss that cache and
 * force a fresh outbound fetch, unthrottled, for as long as the credential's allowlist would accept
 * the url. This caps *that*: total fresh (cache-miss) fetches attributable to one credential,
 * independent of which url/jsonPath each one names. The credential-free path shares the same cap,
 * keyed per site instead of per credential (OpenProject #2185).
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
 * A stable, fixed-width cache key for one site/credential/url/jsonPath combination (OpenProject
 * #2185): `url` and `jsonPath` are author-supplied and otherwise unbounded, so concatenating them raw
 * (as this used to) let an arbitrarily long request grow the cache key without limit — including
 * evicting other entries this same `WIKI.cache` instance holds. Hashing collapses either one to a
 * fixed width regardless of input length.
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
 * A credential's `allowedOrigins` is a second, independent guard, checked once a `credentialId` is
 * given: even an author who legitimately knows a credential's id may not point it at any URL — only
 * an origin+path-prefix the admin who created that credential explicitly allowed
 * (`helpers/network.ts#originMatchesAllowlist`), and only over `https:` — a credential is never sent
 * in cleartext, regardless of what scheme an allowlist entry itself names (OpenProject #2185,
 * #2198). This is what stops a `write:pages` author from exfiltrating a `manage:sites`-gated secret
 * to a URL (or a path on an otherwise-allowed host) of their own choosing.
 *
 * A per-credential (and, since OpenProject #2185, per-site for the credential-free path) rate limit
 * is a third, independent guard (OpenProject #1050): even though a credentialed request now requires
 * an authenticated caller (OpenProject #2202; see `api/liveData.ts`'s header comment), any reader with
 * an account can still reach this, and a credential's allowlist narrows *where* its secret may be sent
 * but not *how often*. Without this, a caller could vary the url/jsonPath on every request to bypass
 * the response cache and drive unlimited fresh fetches against whatever the allowed origin hosts. See
 * {@link RATE_LIMIT_MAX_PER_WINDOW}. Rate-limit accounting only ever runs against a credential that
 * has already been loaded and has already passed its allowlist and scheme checks — an id that
 * resolves to nothing must not be able to burn down another (or a future) credential's budget.
 *
 * `WIKI.config.offline` is a fourth, independent guard (OpenProject #2212), checked immediately after
 * the cache lookup and before anything else on the fresh-fetch path — including the DNS resolution
 * {@link assertNotPrivateAddress} performs. A cache hit is still served (nothing is reached), but a
 * fresh fetch refuses with a 503 rather than reaching out, the same way `diagramRender.ts` gates its
 * PlantUML fetch: an operator who has put the instance in offline mode expects nothing on this path
 * to touch the network at all, not even to resolve a hostname.
 */
class LiveData {
  /**
   * @throws {CustomError} `Bad Request` (400) for a malformed URL/JSONPath, a bare `$` JSONPath, an
   *   unmatched JSONPath, a URL resolving to a private/loopback/link-local address, a credentialed
   *   request whose URL is not `https:`, or a URL outside a given credential's allowed origins,
   *   `Not Found` (404) for a `credentialId` with no matching row on this site, `Too Many Requests`
   *   (429) once a credential (or, for a credential-free request, this site) has exceeded its
   *   fresh-fetch rate limit, `Service Unavailable` (503) when the instance is in offline mode,
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
    if (request.jsonPath.trim() === '$') {
      // -> `extractJsonPathValue`'s `wrap: true` query returns `results[0]` of whatever a `$` query
      //    matches, which for the root selector is the entire parsed upstream document -- and `$` is
      //    the block's own default for this prop (`blocks/block-live-data/component.js`). Refusing it
      //    here is what stops a host-level fetch allowance from doubling as a whole-document read
      //    primitive: an author must name the one field they actually want.
      throw new CustomError(
        'Bad Request',
        'jsonPath must not be a bare "$", which returns the entire response. Name a specific field, e.g. "$.data.value".',
        400
      )
    }

    const refreshSeconds = clampRefreshSeconds(request.refreshInterval)
    const cacheKey = buildCacheKey(siteId, request.credentialId, request.url, request.jsonPath)
    const cached = WIKI.cache.get(cacheKey) as LiveDataResult | undefined
    if (cached) {
      return cached
    }

    if (WIKI.config.offline) {
      throw new CustomError(
        'liveDataOffline',
        'Cardinal.js is in offline mode and cannot reach this endpoint to resolve live data.',
        503
      )
    }

    const validatedAddresses = await this.assertNotPrivateAddress(url)

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (request.credentialId) {
      const credential = await WIKI.models.blockCredentials.getCredentialForResolve(
        siteId,
        request.credentialId
      )
      if (credential === undefined) {
        throw new CustomError('Not Found', 'No such credential on this site.', 404)
      }
      // -> Checked before the allowlist, and unconditionally -- a credential's `allowedOrigins`
      //    entries may themselves be `http:` (schema-valid, see `helpers/network.ts`), but a
      //    credentialed request is never allowed to actually send the secret in cleartext, so this
      //    is enforced here rather than left as something an admin's allowlist choice controls.
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
      // -> Only reached once the credential exists and its allowlist/scheme checks both pass, so an
      //    unresolvable or disallowed credentialId never consumes this credential's rate-limit budget.
      await this.assertWithinRateLimit(request.credentialId)
      headers.Authorization = `Bearer ${credential.secret}`
    } else {
      await this.assertWithinRateLimit(anonymousRateLimitKey(siteId))
    }

    // -> Pins the actual TCP connection to one of the addresses `assertNotPrivateAddress` just
    //    validated, rather than letting undici resolve the hostname a second time on its own — see
    //    `createPinnedDispatcher`'s own comment for why a second, unpinned resolution is exploitable
    //    even though the pre-check above already ran.
    const dispatcher = this.createPinnedDispatcher(validatedAddresses)
    try {
      let response: Response
      try {
        // -> `redirect: 'error'` rather than the default `'follow'`: a redirect response is never
        //    resolved by `assertNotPrivateAddress` above, so following one would hand the credential's
        //    bearer token (and the DNS check itself) to whatever address the *response* names instead
        //    of the one the author configured — the same SSRF hole the pre-check exists to close,
        //    reopened one hop later. A malformed or unreachable-by-design redirect target throws here,
        //    which the catch below reports as the same `Bad Gateway` any other network failure gets.
        // -> `dispatcher` is an undici-specific extension to `fetch`'s options that Node's own
        //    (DOM-derived) `RequestInit` type does not declare, hence the cast.
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
      WIKI.cache.set(cacheKey, result, { ttl: refreshSeconds * 1000 })
      return result
    } finally {
      await dispatcher.close()
    }
  }

  /**
   * Counts this fresh (cache-miss) fetch against `rateLimitKey`'s rate limit and throws once the
   * window's cap is exceeded — see the class comment and {@link RATE_LIMIT_MAX_PER_WINDOW}.
   * `rateLimitKey` is a credential id for a credentialed request, or {@link anonymousRateLimitKey}'s
   * per-site key for a credential-free one — each is its own independent budget.
   *
   * Delegates to `WIKI.models.rateLimits.consume` (OpenProject #1700) — the same durable,
   * postgres-backed fixed-window limiter `models/hooks.ts#emit()` uses for webhook delivery — rather
   * than counting in `WIKI.cache`. A single upsert reads, rolls over, increments and possibly bans the
   * row atomically, so this is also safe across a cluster of backend instances sharing one counter per
   * credential, not just within one process.
   *
   * @throws {CustomError} `Too Many Requests` (429) once the count exceeds the cap.
   */
  private async assertWithinRateLimit(rateLimitKey: string): Promise<void> {
    const verdict = await WIKI.models.rateLimits.consume(
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
   * Resolves `url`'s hostname and refuses to continue if any address it comes back with is private,
   * loopback, or link-local — see the class comment. Fails closed: a hostname that cannot be resolved
   * at all is refused with the same 400 rather than left for the real fetch to fail on its own. That
   * used to be deliberate ("left for the real fetch to fail on its own"), but `dns.lookup` here and
   * undici's own resolution for the real fetch are not guaranteed to agree — a transient resolver
   * failure on this lookup with a *successful* one moments later for the actual fetch would skip the
   * check entirely, which needs no attacker-controlled DNS to happen (OpenProject #2239).
   *
   * @returns The resolved, validated addresses — reused by {@link createPinnedDispatcher} so the
   *   connection undici actually opens is pinned to one of these, not resolved a second time.
   * @throws {CustomError} `Bad Request` (400) when the hostname cannot be resolved, or when any
   *   resolved address is non-public.
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

  /** Broken out so a test can mock it — the same pattern `diagramRender.ts#launchBrowser` uses. */
  private async resolveAddresses(hostname: string): Promise<string[]> {
    const results = await dns.lookup(hostname, { all: true })
    return results.map((result) => result.address)
  }

  /**
   * Builds a per-request undici `Agent` whose connector never resolves the hostname again — its
   * `connect.lookup` (the same signature and slot `dns.lookup` fills for `net.connect`/`tls.connect`)
   * ignores whatever the target actually resolves to at connect time and returns only the addresses
   * `assertNotPrivateAddress` already validated moments earlier.
   *
   * Without this, the fetch below would repeat the hostname lookup itself (undici resolves the
   * hostname it was given, same as any HTTP client) — a second, independent resolution with no
   * connection to the one just validated. A nameserver an attacker controls can answer the pre-check's
   * lookup with a public address and this second one with a private one (classic TTL-0 DNS rebinding);
   * pinning to the pre-validated set closes that gap by making a second lookup never happen at all.
   *
   * @param validatedAddresses IP literals `assertNotPrivateAddress` already confirmed are non-private —
   *   the only addresses this dispatcher's connector will ever hand back.
   */
  private createPinnedDispatcher(validatedAddresses: string[]): Agent {
    return new Agent({ connect: { lookup: this.createPinnedLookup(validatedAddresses) } })
  }

  /**
   * Broken out from {@link createPinnedDispatcher} so a test can call it directly and inspect its
   * callback behavior, rather than reaching into an undici `Agent` instance's private internals.
   *
   * Ignores the hostname it is asked to resolve entirely — the whole point is that this never performs
   * a real lookup, only ever hands back (a subset of) the addresses it was built with.
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
