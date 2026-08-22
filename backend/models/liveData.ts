import { CustomError } from '../helpers/common.ts'
import { extractJsonPathValue } from '../helpers/jsonPath.ts'

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
 */
class LiveData {
  /**
   * @throws {CustomError} `Bad Request` (400) for a malformed URL/JSONPath or an unmatched JSONPath,
   *   `Not Found` (404) for a `credentialId` with no matching row on this site, `Bad Gateway` (502)
   *   for a network failure, a non-2xx response, or a response body that isn't JSON.
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
    const cached = WIKI.cache.get<LiveDataResult>(cacheKey)
    if (cached) {
      return cached
    }

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (request.credentialId) {
      const secret = await WIKI.models.blockCredentials.getSecret(siteId, request.credentialId)
      if (secret === undefined) {
        throw new CustomError('Not Found', 'No such credential on this site.', 404)
      }
      headers.Authorization = `Bearer ${secret}`
    }

    let response: Response
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
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
    WIKI.cache.set(cacheKey, result, refreshSeconds)
    return result
  }
}

export const liveData = new LiveData()
