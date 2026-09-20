import crypto from 'node:crypto'
import mime from 'mime'
import fsp from 'node:fs/promises'
import type { FastifyReply, FastifyRequest } from 'fastify'

export interface Deferred<T = void> {
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
  promise: Promise<T>
}

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

export function decodeTreePath(str?: string | null): string | undefined {
  return str?.replaceAll('.', '/')
}

export function encodeTreePath(str?: string | null): string {
  return str?.toLowerCase()?.replaceAll('/', '.') || ''
}

/**
 * The single form a page path is stored, addressed and looked up under: a URL differing only in
 * casing or in how a space was encoded is the same page, so everything taking a path from a human
 * or from page content passes it through here first. Whether the result is *allowed* is the page
 * model's rule to enforce, on the normalized form.
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
 * Pages are addressed without an extension, but links to the file a page was written as (an export,
 * a repository mirror, a migration) keep turning up, so a path ending in one of the site's page
 * extensions means the page underneath it. Only the last segment counts, and only with a name
 * before the dot: `/.md` and `/docs.md/thing` address nothing.
 *
 * @param extensions Lowercase, without the dot, as the site config stores them
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
 * The one formula for the origin a request arrived on. `req.protocol`/`req.hostname` are already
 * right to pass in: `security.trustProxy` makes Fastify read `X-Forwarded-Proto`/`-Host` behind a
 * reverse proxy, and the host carries any non-default port. Never build a canonical or embed URL
 * from a stored setting instead — a second source drifting from the real public URL is what broke
 * external comment embeds upstream (requarks/wiki #2549, #2784).
 */
export function requestOrigin(protocol: string, hostname: string): string {
  return `${protocol}://${hostname}`
}

/**
 * A WebSocket handshake is neither subject to the same-origin policy nor preflighted, so CORS does
 * not govern it, and the browser attaches the session cookie for a foreign origin's page exactly as
 * for a same-origin one — a handler's own permission check is no substitute for this.
 *
 * Unlike `models/passkeys.ts#resolveOrigin`, a missing `Origin` is rejected rather than assumed
 * same-origin: every real handshake is a browser upgrade request, which always carries one.
 *
 * @param siteHostnames Every hostname a site on this instance answers to, so a handshake from one
 *   of the instance's own other sites is not rejected as foreign
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

/**
 * A vite build's `[name]-[hash].[ext]` filename.
 *
 * FIXME: also matches the unhashed `logo-cardinal.svg` that `frontend/public/_assets` copies into
 * the build, so it is served immutable. Rename it, or stop inferring a hash from name shape alone.
 */
const HASHED_ASSET_PATTERN = /-([A-Za-z0-9_-]{8})\.[a-z0-9]+$/
const HASH_MIX_PATTERN = /[A-Z0-9_]/

/**
 * A content-hashed name can never point at different bytes, so it may be cached immutable. Meant to
 * be false for the names `frontend/vite.config.js` pins on purpose (`renderer.js`) and for the
 * hand-authored trees under `assets/_assets` that never go through vite.
 *
 * @param filename Basename only, not a full path
 */
export function isHashedAssetFilename(relativePath: string): boolean {
  if (/[\\/]/.test(relativePath)) {
    return false
  }
  const hash = HASHED_ASSET_PATTERN.exec(relativePath)?.[1]
  return hash !== undefined && HASH_MIX_PATTERN.test(hash)
}

export function generateHash(str: string): string {
  return crypto.createHash('sha1').update(str).digest('hex')
}

/** RFC 4122 UUID, versions 1-8, case-insensitive. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/**
 * A page is addressed by the hash of its path so that a path with slashes stays one URL segment.
 * Clients compute it before asking for a page, so this cyrb53 must agree bit for bit with
 * `pagePathHash` in `frontend/src/helpers/pagePaths.js` and `blocks/shared/site.js`. A lookup key,
 * not a security boundary.
 *
 * @param str Page path, without a leading slash
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
 * One number and one unit (`30s`, `15m`, `2h`, `7d`, `2w`, `1y`) — the form `DURATION_PATTERN` in
 * `models/security.ts` accepts. A year is 365 days and no month is offered: these measure how long
 * something lasts, not what date it lands on.
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
 * The URL answered through here never changes across a redeploy while the bytes can, so the
 * caller's `Cache-Control` should always revalidate (`public, no-cache`): a long `max-age` would
 * keep serving the old bytes. The strong ETag (the file's sha1) turns most loads into a 304, at the
 * cost of reading and hashing the file per request — fine for small, rarely-requested files, not
 * for large or hot content.
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
 * Postgres' unique-violation (`23505`), thrown bare or re-thrown by the query builder as
 * `err.cause`. Write paths that check first and insert anyway rely on it: the constraint is the
 * real arbiter, since another writer can land between the check and the insert.
 */
export function isUniqueViolation(err: unknown): boolean {
  const candidate = err as { code?: unknown; cause?: { code?: unknown } } | null | undefined
  return candidate?.code === '23505' || candidate?.cause?.code === '23505'
}

/**
 * Values are still parameterized by the driver — this is about a `%` in a user-supplied filter
 * silently matching everything, not about injection.
 */
export function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/**
 * One constant for every bcrypt hash (account and page passwords, recovery codes, seeded accounts):
 * the cost is a single security decision, and a hash written at a different cost than its
 * neighbours reads back as a mistake.
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
 * The authentication models reject a request by throwing an `ERR_*` code the client has a
 * translation for, so the code travels as the message of a 400. Anything else is a real fault, left
 * for the error handler to log and answer 500.
 */
export function rethrowAsBadRequest(err: any): never {
  if (typeof err?.message === 'string' && err.message.startsWith('ERR_')) {
    throw new CustomError('Bad Request', err.message)
  }
  throw err
}

const BYTE_SIZE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

/**
 * Decimal (1000-based) unit steps, matching the `filesize` package's default output. A value that
 * rounds to 1000 at its own unit is promoted to the next: 999999 bytes is `'1 MB'`, not
 * `'1000 kB'`.
 */
export function formatByteSize(bytes: number): string {
  if (!bytes) {
    return '0 B'
  }
  let e = Math.floor(Math.log(bytes) / Math.log(1000))
  if (e < 0) {
    e = 0
  } else if (e > 8) {
    e = 8
  }
  let val = bytes / 1000 ** e
  val = e > 0 ? Math.round(val * 100) / 100 : Math.round(val)
  if (val === 1000 && e < 8) {
    val = 1
    e++
  }
  return `${val} ${BYTE_SIZE_UNITS[e]}`
}
