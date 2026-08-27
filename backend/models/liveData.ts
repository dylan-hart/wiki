import dns from 'node:dns/promises'
import type * as dnsTypes from 'node:dns'
import net from 'node:net'
import { Agent } from 'undici'
import { CustomError } from '../helpers/common.ts'
import { extractJsonPathValue } from '../helpers/jsonPath.ts'
import { hostnameMatchesAllowlist, isPrivateAddress } from '../helpers/network.ts'

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
 */
const RATE_LIMIT_WINDOW_SECONDS = 60
const RATE_LIMIT_MAX_PER_WINDOW = 120

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

    const validatedAddresses = await this.assertNotPrivateAddress(url)

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (request.credentialId) {
      this.assertWithinRateLimit(request.credentialId)
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
   * Counts this fresh (cache-miss) fetch against `credentialId`'s rate limit and throws once the
   * window's cap is exceeded — see the class comment and {@link RATE_LIMIT_MAX_PER_WINDOW}.
   *
   * A fixed window, not a sliding one: `WIKI.cache.getRemainingTTL` reports how much longer the
   * current window's key has left, and that remaining time is preserved (via `WIKI.cache.set`'s own
   * `ttl` option) on every increment rather than reset — resetting it on every request would mean a
   * credential at exactly its cap, with requests still arriving, would never see the window lapse and
   * would stay throttled forever instead of recovering once the offending traffic actually stops.
   *
   * @throws {CustomError} `Too Many Requests` (429) once the count exceeds the cap.
   */
  private assertWithinRateLimit(credentialId: string): void {
    const key = `${RATE_LIMIT_PREFIX}${credentialId}`
    const remainingMs = WIKI.cache.getRemainingTTL(key)
    const windowIsFresh = remainingMs <= 0
    const count = (windowIsFresh ? 0 : ((WIKI.cache.get(key) as number | undefined) ?? 0)) + 1
    const remainingSeconds = windowIsFresh
      ? RATE_LIMIT_WINDOW_SECONDS
      : Math.max(1, Math.ceil(remainingMs / 1000))
    WIKI.cache.set(key, count, { ttl: remainingSeconds * 1000 })
    if (count > RATE_LIMIT_MAX_PER_WINDOW) {
      throw new CustomError(
        'Too Many Requests',
        'This credential is being used to fetch too frequently. Try again shortly.',
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
