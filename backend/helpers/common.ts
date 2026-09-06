import crypto from 'node:crypto'
import mime from 'mime'
import fsp from 'node:fs/promises'
import type { FastifyReply, FastifyRequest } from 'fastify'

export interface Deferred<T = void> {
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
  promise: Promise<T>
}

/** Seconds in each unit a duration setting may be written with. See `durationToSeconds`. */
const DURATION_UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  y: 31536000
} as const

type DurationUnit = keyof typeof DURATION_UNIT_SECONDS

/* eslint-disable promise/param-names */
export function createDeferred<T = void>(): Deferred<T> {
  let result: Promise<T> | undefined
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined
  let reject: ((reason?: unknown) => void) | undefined
  return {
    resolve: function (value: T) {
      if (resolve) {
        resolve(value)
      } else {
        result =
          result ||
          new Promise<T>(function (r) {
            r(value)
          })
      }
    },
    reject: function (reason?: unknown) {
      if (reject) {
        reject(reason)
      } else {
        result =
          result ||
          new Promise<T>(function (x, j) {
            j(reason)
          })
      }
    },
    promise: new Promise<T>(function (r, j) {
      if (result) {
        r(result)
      } else {
        resolve = r
        reject = j
      }
    })
  }
}

/**
 * Decode a tree path
 *
 * @param str String to decode
 * @returns Decoded tree path
 */
export function decodeTreePath(str?: string | null): string | undefined {
  return str?.replaceAll('.', '/')
}

/**
 * Encode a tree path
 *
 * @param str String to encode
 * @returns Encoded tree path
 */
export function encodeTreePath(str?: string | null): string {
  return str?.toLowerCase()?.replaceAll('/', '.') || ''
}

/**
 * Reduce a page path to the single form it is stored, addressed and looked up under.
 *
 * A path is a URL, and a URL that differs only in casing or in how a space was encoded is the same
 * page as far as anyone reading the wiki is concerned — so there is one spelling, and everything
 * that takes a path from a human or from page content passes it through here first. Wrapping slashes
 * go, runs of whitespace become a single hyphen, and what is left is lowercased.
 *
 * What it does not do is decide whether the result is *allowed*: the characters a path may contain
 * are the page model's rule to enforce, on the normalized form.
 */
export function normalizePagePath(input?: string | null): string {
  return (input ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replaceAll(/\s+/g, '-')
    .toLowerCase()
}

/**
 * Drop a site's page extension from the end of a URL path.
 *
 * A wiki's pages are addressed without one — `/foo/bar`, not `/foo/bar.md` — but the file the page
 * was written as keeps turning up in links: an export, a repository mirror, a migration from a system
 * that served files. So a site lists the extensions its content is written in, and a path ending in
 * one of them means the page underneath it.
 *
 * Only the last segment is considered, and only when there is a name in front of the dot: `/.md` and
 * `/docs.md/thing` address nothing.
 *
 * @param extensions Lowercase, without the dot, as the site config stores them
 * @returns The path without the extension, or null if it does not end in one of them
 */
export function stripPageExtension(urlPath: string, extensions?: string[] | null): string | null {
  if (!extensions || extensions.length < 1) {
    return null
  }
  const dot = urlPath.lastIndexOf('.')
  if (dot < 1 || urlPath[dot - 1] === '/' || urlPath.lastIndexOf('/') > dot) {
    return null
  }
  if (!extensions.includes(urlPath.slice(dot + 1).toLowerCase())) {
    return null
  }
  return urlPath.slice(0, dot)
}

/**
 * The absolute origin (scheme + host, port included whenever the host itself carries one) a request
 * actually arrived on.
 *
 * Deliberately just `${protocol}://${hostname}` — Fastify's own `req.protocol`/`req.hostname` are
 * already the right values to pass in, *because* `security.trustProxy` (wired in `index.ts` as
 * `trustProxy: WIKI.config.security.trustProxy`) is what makes Fastify read `X-Forwarded-Proto` /
 * `X-Forwarded-Host` instead of the raw socket's own scheme/host when the instance sits behind a
 * reverse proxy — and `X-Forwarded-Host` (like `Host` itself) already carries a non-default port when
 * the browser's address bar does. So there is nothing left for this function to compute; its entire
 * job is to be the *one* formula every caller uses, rather than each re-deriving `protocol://host`
 * slightly differently.
 *
 * That "slightly differently" is exactly the failure mode this function exists to close off: two
 * upstream Wiki.js reports (requarks/wiki #2549 — a Disqus "config error" — and #2784 — Commento
 * "not loading on a page with a different URL") both traced back to the canonical/base URL an
 * external comment embed was told to identify a page by having drifted from the site's real public
 * URL, because it came from a second, independently-configured place (2.x's admin-typed "Site URL"
 * setting) that nothing kept in sync with what the request was actually reached on. Passing
 * `req.protocol`/`req.hostname` straight through — never a stored setting, never assembled by hand a
 * second time — makes that drift structurally impossible: there is only one source, the request
 * itself. `controllers/seo.ts`'s sitemap/robots.txt goes through this, and so must any future
 * embed/canonical-URL builder.
 */
export function requestOrigin(protocol: string, hostname: string): string {
  return `${protocol}://${hostname}`
}

/**
 * Whether a WebSocket handshake's `Origin` header agrees with the host it was addressed to.
 *
 * A WebSocket handshake is not subject to the same-origin policy and is not preflighted, so CORS
 * governs neither the handshake nor the frames that follow it — and unlike a form POST, the response
 * is fully readable by whichever origin opened the socket. This is the `verifyClient` check on the
 * single `@fastify/websocket` registration in `index.ts`, so every present and future `websocket:
 * true` route (`controllers/terminal.ts`, `controllers/collab.ts`) inherits it, rather than each
 * handler re-deriving its own gate — the permission checks those two already do are correct on their
 * own terms, but neither one is a substitute for this: a permission check runs the handler's own
 * logic against whatever session cookie the browser attached, and a foreign origin's page gets that
 * cookie attached by the browser exactly as a same-origin one would.
 *
 * Mirrors `models/passkeys.ts#resolveOrigin`'s host-equality pattern, with one deliberate difference:
 * that function treats a *missing* `Origin` as a legitimate non-browser API client and assumes the
 * canonical origin, because a WebAuthn ceremony genuinely has such callers. A WebSocket handshake does
 * not — every real one is a browser upgrade request, which always carries `Origin` — so here a missing
 * header is rejected rather than assumed same-origin.
 *
 * @param origin The raw `Origin` header off the upgrade request, if the client sent one
 * @param host The raw `Host` header off the upgrade request (what `req.host` reads)
 * @param siteHostnames Every hostname a site on this instance answers to (`WIKI.sitesMappings`'
 *   keys), so a handshake from one of the instance's own other sites is not rejected as foreign
 */
export function isSameOriginWebSocketHandshake(
  origin: string | undefined,
  host: string | undefined,
  siteHostnames?: Iterable<string>
): boolean {
  if (!origin || !host) {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.host === host) {
    return true
  }
  if (siteHostnames) {
    for (const hostname of siteHostnames) {
      if (parsed.hostname === hostname) {
        return true
      }
    }
  }
  return false
}

/** A vite build's `[name]-[hash].[ext]` filename, whose hash segment can never point at different bytes. */
const HASHED_ASSET_PATTERN = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/

/**
 * Whether an `/_assets/` basename carries a vite-generated content hash, and can therefore be served
 * with an immutable, far-future cache header.
 *
 * `frontend/vite.config.js`'s `entryFileNames`/asset naming appends `-[hash]` (an 8+ character
 * base62-ish string) before the extension to every build output except the handful of names it pins
 * on purpose (`renderer.js`, kept fixed because a static server-rendered page references it by name)
 * — those, plus the hand-authored trees under `assets/_assets` that never go through vite at all
 * (`fonts/`, `icons/`, `illustrations/`, `storage/`, `svg/`), are exactly the entries this returns
 * `false` for.
 *
 * @param filename Basename only (`path.basename(filePath)`), not a full path
 */
export function isHashedAssetFilename(filename: string): boolean {
  return HASHED_ASSET_PATTERN.test(filename)
}

/**
 * Generate SHA-1 Hash of a string
 *
 * @param str String to hash
 * @returns Hashed string
 */
export function generateHash(str: string): string {
  return crypto.createHash('sha1').update(str).digest('hex')
}

/** RFC 4122 UUID, versions 1-8, case-insensitive -- matches what the removed `uuid` package's own `validate()` accepted. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/**
 * Hash a page path the way the frontend does.
 *
 * A page is addressed by the hash of its path rather than the path itself, so that a URL with slashes
 * in it stays a single path segment. The frontend computes this before asking for a page, so the two
 * implementations have to agree exactly — this is cyrb53, mirroring `fastHash` in
 * `frontend/src/stores/page.js`. Not a security boundary: it is a lookup key, and it is checked
 * against the site it was requested for.
 *
 * @param str Page path, without a leading slash
 * @returns 53-bit hash as a hex string
 */
export function generatePathHash(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

/**
 * How long a duration written the way the admin area writes them lasts, in seconds.
 *
 * `30s`, `15m`, `2h`, `7d`, `2w`, `1y` — one number and one unit, which is the form every duration
 * setting takes (the JWT ones included) and the form `DURATION_PATTERN` in `models/security.ts`
 * accepts. A year is 365 days and a month is not offered at all: these measure how long something
 * lasts, not what date it lands on, so a calendar has no say in it.
 *
 * @param fallback Returned for anything unparseable, so one bad setting cannot turn a limit off
 */
export function durationToSeconds(value: unknown, fallback: number): number {
  const match = /^(\d+)([smhdwy])$/.exec(String(value ?? '').trim())
  if (!match) {
    return fallback
  }
  const seconds = Number(match[1]) * DURATION_UNIT_SECONDS[match[2] as DurationUnit]
  return seconds > 0 ? seconds : fallback
}

/**
 * A file's bytes only change when this codebase's own on-disk contents change (a redeploy — a new
 * build, a new process), never in response to a request — but that is exactly why the URL a caller
 * answers through this function needs to always revalidate rather than being cached long: the URL
 * itself never changes across a redeploy, so a browser holding a fresh copy of the OLD bytes has no
 * way to learn new ones landed until it actually asks again. "Only changes on redeploy" is the reason
 * a long `max-age` is UNSAFE here, not the reason it would be fine — a browser that cached the bytes
 * before a redeploy keeps serving them for the rest of that window with no chance to notice, which is
 * exactly the caching-versus-branding bug this function used to cause (OpenProject #2724). The caller
 * supplies its own `Cache-Control`, which should say so (`public, no-cache` is what every current
 * caller passes), and this always sends a strong ETag — the file's own sha1 — so a `no-cache` policy
 * still turns almost every load into a cheap 304 rather than a full re-download, at the one-time cost
 * of reading and hashing the file per request. That cost is fine for what actually calls this: small,
 * infrequently-requested branding fallbacks, not large or hot content.
 */
export async function replyWithFile(
  req: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  options: { cacheControl: string }
): Promise<FastifyReply> {
  const [stats, buffer] = await Promise.all([fsp.stat(filePath), fsp.readFile(filePath)])
  const etag = `"${crypto.createHash('sha1').update(buffer).digest('hex')}"`
  reply.header('Content-Type', mime.getType(filePath))
  reply.header('Cache-Control', options.cacheControl)
  reply.header('ETag', etag)
  reply.header('Last-Modified', stats.mtime.toUTCString())
  if (req.headers['if-none-match'] === etag) {
    return reply.code(304).send()
  }
  return reply.send(buffer)
}

/**
 * Whether a failure is postgres' unique-violation (`23505`), however the driver wrapped it.
 *
 * Nine write paths — page create/move, a tree entry, a glossary term, a block, a user — race a
 * uniqueness constraint deliberately: they check first, insert anyway, and treat the constraint as
 * the real arbiter of who won, since another writer can always land between the check and the
 * insert. Each one asked the same two-part question (`err.code`, and `err.cause?.code` for the same
 * error re-thrown by the query builder), which is exactly the sort of predicate that drifts when a
 * tenth site copies only one half of it.
 */
export function isUniqueViolation(err: unknown): boolean {
  const candidate = err as { code?: unknown; cause?: { code?: unknown } } | null | undefined
  return candidate?.code === '23505' || candidate?.cause?.code === '23505'
}

/**
 * Escape the LIKE wildcards `%` and `_` (and the escape character itself) so that a user-supplied
 * filter is matched literally. Values are still parameterized by the driver — this is about a `%`
 * in the filter silently matching everything, not about injection.
 */
export function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/**
 * The bcrypt cost factor everything this codebase hashes is hashed at — account passwords, a page's
 * own password, a 2FA recovery code, the random password an imported or seeded account gets.
 *
 * One constant rather than a `12` written at each call site (plus two identically-valued private
 * constants of its own): the cost is a single security decision about this instance, and a hash
 * written at a different cost than its neighbours is indistinguishable from a mistake when read
 * back.
 */
export const BCRYPT_ROUNDS = 12

export class CustomError extends Error {
  statusCode: number

  constructor(name: string, message: string, statusCode = 400) {
    super(message)
    this.name = name
    this.statusCode = statusCode
  }
}

/**
 * Rethrow a failure raised by the authentication models as an HTTP error.
 *
 * Those models signal a rejected request by throwing an `ERR_*` code rather than prose, because the
 * client has a translation for each one — so the code travels to the client as the message of a 400.
 * Anything else is an actual fault and is left alone, for the error handler to log and answer 500 to.
 */
export function rethrowAsBadRequest(err: any): never {
  if (typeof err?.message === 'string' && err.message.startsWith('ERR_')) {
    throw new CustomError('Bad Request', err.message)
  }
  throw err
}
