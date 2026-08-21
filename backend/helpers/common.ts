import { isNil, isPlainObject } from 'es-toolkit/predicate'
import { startCase } from 'es-toolkit/string'
import crypto from 'node:crypto'
import mime from 'mime'
import fs from 'node:fs'
import type { FastifyReply } from 'fastify'

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
 * itself. `controllers/seo.ts`'s sitemap/robots.txt and `commentProviders.ts`'s `canonicalPageUrl`
 * (for any future `codeTemplate` provider's embed) both go through this.
 */
export function requestOrigin(protocol: string, hostname: string): string {
  return `${protocol}://${hostname}`
}

/** What a page/shell request's hostname resolved to, for the site-resolution hook in `index.ts`. */
export type RequestSiteResolution =
  | { outcome: 'exempt' }
  | { outcome: 'not-found' }
  | { outcome: 'disabled'; site: Record<string, any> }
  | { outcome: 'ok'; site: Record<string, any> }

/**
 * Decide what a page/shell request's hostname resolves to, and whether the request should be let
 * through at all.
 *
 * Mirrors the SEO hook's precedence in `index.ts` exactly — `sitesMappings[hostname] ||
 * sitesMappings['*']` — so a request sees the same site the SEO hook already used to decide whether
 * to strip a page extension.
 *
 * `exemptSegments` is the caller's list of first path segments that must reach the app shell
 * regardless of what the hostname resolves to — the fix path for a disabled or unmatched site has to
 * survive the very thing it exists to correct.
 */
export function resolveRequestSite({
  firstSegment,
  hostname,
  sitesMappings,
  sites,
  exemptSegments
}: {
  firstSegment: string
  hostname: string
  sitesMappings: Record<string, string>
  sites: Record<string, any>
  exemptSegments: ReadonlySet<string>
}): RequestSiteResolution {
  if (exemptSegments.has(firstSegment)) {
    return { outcome: 'exempt' }
  }
  const siteId = sitesMappings[hostname] || sitesMappings['*']
  const site = siteId ? sites[siteId] : null
  if (!site) {
    return { outcome: 'not-found' }
  }
  if (site.isEnabled === false) {
    return { outcome: 'disabled', site }
  }
  return { outcome: 'ok', site }
}

/** The message every disabled-site `403` answers with — see `guardSiteEnabled`. */
export const SITE_DISABLED_MESSAGE = 'This wiki site is currently disabled.'

/**
 * Response contract for a site resolved OUTSIDE the page/shell hook in `index.ts` — an API route or
 * static controller that already has a siteId or hostname of its own (a JSON endpoint, an image, a
 * downloaded file) rather than one arriving through `resolveRequestSite` above. Those requests are
 * not navigations a browser can be bounced away from, so where the hook redirects to a distinct
 * `/_error/*` page per outcome, these tell the same two outcomes apart by status code instead:
 *
 * - No site at all behind the id/hostname is indistinguishable from any other missing resource, so
 *   the caller keeps answering its own `reply.notFound(...)` with whatever message fits what it was
 *   looking up — this function has nothing to add there.
 * - A site that exists but has `isEnabled === false` answers `403` here — "exists, access refused",
 *   the same shape a page-rule denial already answers with elsewhere in these routes — rather than
 *   `404`, so a client can tell "wrong id" apart from "right id, wait for it to come back".
 *
 * A caller that already resolved a site row (`bootstrap.ts`, `controllers/site.ts`,
 * `controllers/files.ts`) passes it directly. A caller scoped only to a bare `siteId` (the
 * `/sites/:siteId/...` API routes) passes `WIKI.sites[siteId]` — `undefined` for an id that does not
 * exist, which this deliberately treats as "nothing to guard here" rather than a second 404: those
 * routes already answer "no such thing" through their own lookup once this guard lets the request
 * through.
 *
 * Returns `true` once a reply has been sent, so the caller can `return` immediately after.
 */
export function guardSiteEnabled(
  site: { isEnabled?: boolean } | null | undefined,
  reply: FastifyReply
): boolean {
  if (site?.isEnabled === false) {
    reply.forbidden(SITE_DISABLED_MESSAGE)
    return true
  }
  return false
}

/**
 * A site's `config.locales` shape, as far as URL routing cares about it.
 */
export interface LocaleRoutingConfig {
  primary: string
  active: string[]
  forcePrefix?: boolean
}

/**
 * Split the recognized leading locale segment off a URL path.
 *
 * A locale-prefixed URL (`/fr/some/page`) and an ordinary one (`/some/page`) are the same shape —
 * the only thing that tells them apart is whether the first segment happens to be one of the site's
 * active locale codes, which is why this takes the site's `locales` config rather than trying to
 * recognize a locale code on its own. Matching is case-insensitive (a link typed as `/FR/page` still
 * counts), but the code returned is always the one as stored in `active`, never the request's casing.
 *
 * Only the presence of a match is decided here — what to do about it (redirect, strip, neither) is
 * the caller's call, same division as `stripPageExtension`.
 *
 * @returns The matched locale code and the path with it removed, or null if the first segment isn't
 *   one of `active`'s codes
 */
export function stripLocalePrefix(
  urlPath: string,
  locales?: LocaleRoutingConfig | null
): { locale: string; path: string } | null {
  if (!locales?.active || locales.active.length < 1) {
    return null
  }
  const segments = urlPath.split('/')
  const firstSegment = segments[1] ?? ''
  if (!firstSegment) {
    return null
  }
  const match = locales.active.find((code) => code.toLowerCase() === firstSegment.toLowerCase())
  if (!match) {
    return null
  }
  const rest = '/' + segments.slice(2).join('/')
  return { locale: match, path: rest === '/' ? '/' : rest }
}

/**
 * Whether a page URL should be redirected to carry its site's forced locale prefix, and if so, where.
 *
 * A site with more than one active locale can require every page URL to name one up front
 * (`locales.forcePrefix`), so a link copied out of the address bar unambiguously encodes which
 * translation it points at. There is nothing to disambiguate with a single active locale, and a site
 * with `forcePrefix` off has chosen to leave its primary locale unprefixed — both cases return null
 * without even asking `stripLocalePrefix` whether the path already names one.
 *
 * @returns The path to redirect to (query string still needs reattaching, as with
 *   `stripPageExtension`'s result), or null if no redirect is warranted
 */
export function localePrefixRedirectTarget(
  urlPath: string,
  locales?: LocaleRoutingConfig | null
): string | null {
  if (!locales?.forcePrefix || !locales.active || locales.active.length <= 1) {
    return null
  }
  if (stripLocalePrefix(urlPath, locales)) {
    return null
  }
  return `/${locales.primary}${urlPath === '/' ? '' : urlPath}`
}

/**
 * Whether a page URL carries a locale prefix it should not (or spells one wrong), and if so, where
 * to redirect.
 *
 * The other half of `localePrefixRedirectTarget`: that one ADDS the prefix `forcePrefix` requires;
 * this one REMOVES an explicit prefix the site's rules leave bare (`/en/page` and `/page` are
 * otherwise two URLs for the same document — the sitemap, hreflang and caches all want exactly
 * one), and re-cases a recognized-but-mis-cased prefix to the code as stored in `active`. Returns
 * null when the URL is already canonical.
 *
 * @returns The canonical path to redirect to (query string reattached by the caller), or null
 */
export function localePrefixStripTarget(
  urlPath: string,
  locales?: LocaleRoutingConfig | null
): string | null {
  const stripped = stripLocalePrefix(urlPath, locales)
  if (!stripped) {
    return null
  }
  if (shouldPrefixLocale(stripped.locale, locales)) {
    const canonical = `/${stripped.locale}${stripped.path === '/' ? '' : stripped.path}`
    return canonical === urlPath ? null : canonical
  }
  return stripped.path
}

/**
 * Whether a link addressed at `locale` should carry a locale segment, under a site's locale-prefix
 * rules.
 *
 * The link-building counterpart to `localePrefixRedirectTarget`'s redirect check, and the backend
 * mirror of the frontend's `shouldPrefixLocale` in `helpers/pagePaths.js`: the site's primary locale
 * is left unprefixed and every other active locale is prefixed, so a link built for the common case
 * -- the primary locale -- isn't cluttered with a code nobody chose to see. `forcePrefix` turns that
 * off and prefixes the primary locale too. There is nothing to disambiguate with a single active
 * locale (or none configured), same as `localePrefixRedirectTarget`, so that case never prefixes
 * either -- this is `active.length` standing in for the frontend's `useLocales` flag, which this
 * config shape has no field for.
 *
 * @param locale The link's own locale
 * @param locales The site's locale routing config
 */
export function shouldPrefixLocale(locale: string, locales?: LocaleRoutingConfig | null): boolean {
  if (!locales?.active || locales.active.length <= 1) {
    return false
  }
  return locale !== locales.primary || Boolean(locales.forcePrefix)
}

/**
 * Build a link to a bare page path, prefixed with its locale segment when `shouldPrefixLocale`
 * calls for one. The backend mirror of `localizedPagePath` in `frontend/src/helpers/pagePaths.js`,
 * and the inverse of `stripLocalePrefix`.
 *
 * @param path Bare page path, without a leading slash, as `pages.path` stores it
 * @param locale The path's own locale
 * @returns The slash-leading path to link to
 */
export function localizedPagePath(
  path: string,
  locale: string,
  locales?: LocaleRoutingConfig | null
): string {
  const bare = `/${path}`
  return shouldPrefixLocale(locale, locales) ? `/${locale}${bare}` : bare
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

/**
 * Compare two secrets without leaking which character stopped the comparison.
 *
 * `===` on strings returns as soon as it finds a difference, and the time that takes is measurable
 * across enough attempts. Both sides are digested first because `timingSafeEqual` throws on operands
 * of different lengths — the digest is a fixed 32 bytes, so the length of the candidate says nothing.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest()
  return crypto.timingSafeEqual(digest(a), digest(b))
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
 * Get default value of type
 *
 * @param type primitive type name
 * @returns Default value
 */
export function getTypeDefaultValue(type: string): string | number | boolean | undefined {
  switch (type.toLowerCase()) {
    case 'string':
      return ''
    case 'number':
      return 0
    case 'boolean':
      return false
  }
}

/**
 * A single prop, as declared in a module `definition.yml`. Either the bare primitive type name
 * (e.g. `String`) or an object describing the prop in full.
 */
export type ModulePropDeclaration = ModulePropDefinition | string

export interface ModulePropDefinition {
  type: string
  default?: unknown
  title?: string
  hint?: string
  enum?: string[] | false
  enumDisplay?: string
  multiline?: boolean
  sensitive?: boolean
  readOnly?: boolean
  /** Must resolve to a non-empty value (after merging with what is already stored) to validate. */
  required?: boolean
  /** A regular expression (as a string) the value must match to validate, when non-empty. */
  pattern?: string
  icon?: string
  order?: number
  if?: unknown[]
}

/** A prop after normalization, with every field resolved to a concrete value. */
export interface ModuleProp {
  default: unknown
  type: string
  title: string
  hint: string
  enum: string[] | false
  enumDisplay: string
  multiline: boolean
  sensitive: boolean
  /** Shown but not editable — the module declares something this server cannot currently change. */
  readOnly: boolean
  /** See `ModulePropDefinition.required`. */
  required: boolean
  /** See `ModulePropDefinition.pattern`. Empty string when the module declares none. */
  pattern: string
  icon: string
  order: number
  if: unknown[]
}

export function parseModuleProps(
  props: Record<string, ModulePropDeclaration>
): Record<string, ModuleProp> {
  const result: Record<string, ModuleProp> = {}
  for (const [key, value] of Object.entries(props)) {
    const def: Partial<ModulePropDefinition> = isPlainObject(value) ? value : {}
    const type = def.type || (value as string)
    const defaultValue = !isNil(def.default) ? def.default : getTypeDefaultValue(type)
    result[key] = {
      default: defaultValue,
      type: type.toLowerCase(),
      title: def.title || startCase(key),
      hint: def.hint || '',
      enum: def.enum || false,
      enumDisplay: def.enumDisplay || 'select',
      multiline: def.multiline || false,
      sensitive: def.sensitive || false,
      readOnly: def.readOnly || false,
      required: def.required || false,
      pattern: def.pattern || '',
      icon: def.icon || 'rename',
      order: def.order || 100,
      if: def.if ?? []
    }
  }
  return result
}

export function replyWithFile(reply: FastifyReply, filePath: string): FastifyReply {
  const stream = fs.createReadStream(filePath)
  reply.header('Content-Type', mime.getType(filePath))
  return reply.send(stream)
}

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
