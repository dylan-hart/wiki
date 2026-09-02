import { isNil, isPlainObject } from 'es-toolkit/predicate'
import { startCase } from 'es-toolkit/string'
import crypto from 'node:crypto'
import mime from 'mime'
import fs from 'node:fs'
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
 * Mirrors the SEO hook's precedence in `index.ts` exactly — `sitesMappings[normalizeHostname(hostname)]
 * || sitesMappings['*']` — so a request sees the same site the SEO hook already used to decide
 * whether to strip a page extension.
 *
 * `exemptSegments` is the caller's list of first path segments that must reach the app shell
 * regardless of what the hostname resolves to — the fix path for a disabled or unmatched site has to
 * survive the very thing it exists to correct.
 *
 * `hostname` is trusted as-is here — the refusal of a forwarded host that names a different site than
 * the socket's own `Host` (task 2085, `docs/audit-2026-08-24/security/13-tenancy-isolation.md` §6)
 * happens one layer up, in Fastify itself: `index.ts` passes `security.trustProxy` straight through
 * as Fastify's own `trustProxy` option, and once that is a genuine address/CIDR spec rather than a
 * bare `true`, Fastify's vendored `request.hostname` getter (`fastify/lib/request.js`) only reads
 * `X-Forwarded-Host` from a peer address the spec covers, falling back to the raw `Host` header for
 * everyone else. So by the time `hostname` reaches this function it has already been through that
 * check — there is nothing left to compare it against.
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
  const siteId = sitesMappings[normalizeHostname(hostname)] || sitesMappings['*']
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

/** The message every unknown-`:siteId` `404` answers with — see `siteEnabledPreHandler`. */
export const SITE_MISSING_MESSAGE = 'This site does not exist.'

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
 * exist, which this deliberately treats as "nothing to guard here" rather than a second 404: the one
 * `:siteId` caller left, `siteEnabledPreHandler` below, has already answered that 404 itself before
 * it ever asks this function anything.
 *
 * Returns `true` once a reply has been sent, so the caller can `return` immediately after.
 */
/**
 * The one place a hostname is folded to the form `WIKI.sitesMappings` is keyed and looked up by
 * (OpenProject #2127).
 *
 * DNS names are case-insensitive, but `models/sites.ts#reloadCache()` used to key
 * `WIKI.sitesMappings` by `site.hostname` exactly as stored (already constrained to lowercase by
 * the site create/update schemas — see `api/sites.ts`'s `^(\*|[a-z0-9.-]+)$` pattern — so the
 * WRITE side was already fine) while every READ side indexed it with `req.hostname` exactly as
 * Fastify's `hostname` getter delivers it — case preserved, only the port stripped. A `Host:
 * Wiki.Example.Com` request for a site stored as `wiki.example.com` therefore matched nothing and
 * fell through to the `*` catch-all, or to "not found" with none configured — an unauthenticated
 * correctness/availability defect for any client or intermediary that preserves `Host` case (curl,
 * some HTTP libraries, some proxies), not an escalation, since a mixed-case `Host` already landed
 * on the same catch-all any unknown hostname reaches.
 *
 * Every lookup (and the write side, belt and braces) routes through this rather than each call
 * site lowercasing for itself, so a future lookup added elsewhere cannot silently reintroduce the
 * mismatch.
 */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase()
}

/**
 * Which site a request's hostname resolves to, as `WIKI.sitesMappings` answers it.
 *
 * The other half of `normalizeHostname`'s job (OpenProject #2127): folding the hostname is only
 * useful if every lookup actually does it, and the lookup itself — `sitesMappings[normalized]`,
 * falling back to the `*` catch-all — was written out at five call sites, one of which
 * (`api/diagrams.ts`) indexed `sitesMappings` with the raw `req.hostname` and so missed a mixed-case
 * `Host` entirely, resolving the catch-all site instead of the one addressed. One function, so a
 * lookup added later cannot reintroduce that.
 *
 * @param strict Refuse the `*` catch-all, answering `undefined` for a hostname no site claims —
 *   what `GET /_api/sites/:siteIdorHostname?strict=true` offers a caller that wants to know whether
 *   this exact hostname is configured, rather than which site would serve it
 */
export function siteIdForHostname(
  hostname: string | undefined,
  { strict = false }: { strict?: boolean } = {}
): string | undefined {
  const direct = hostname ? WIKI.sitesMappings[normalizeHostname(hostname)] : undefined
  if (strict) {
    return direct
  }
  return direct || WIKI.sitesMappings['*']
}

/**
 * Resolve the site behind a request's own hostname, or null when the request carries none.
 *
 * The three-line ternary `api/users.ts` repeated for each of its hostname-scoped profile features.
 * Not the same question `siteIdForHostname` answers: this one hands back the cached site record
 * (through the model, so a `forceReload` caller elsewhere still shares one code path), and a request
 * with no `Host` at all resolves to nothing rather than to the `*` catch-all.
 */
export async function siteForHostname(
  hostname: string | undefined,
  { strict = false }: { strict?: boolean } = {}
): Promise<any> {
  return hostname ? await WIKI.models.sites.getSiteByHostname({ hostname, strict }) : null
}

/**
 * Resolve a site named by a path parameter that may be the sentinel `current`, a site id, or a
 * hostname — the three-way spelling `GET /_api/sites/:siteIdorHostname` and `/_site/:siteId/:resource`
 * each wrote out for themselves.
 *
 * `current` means "whichever site this request was addressed to", so it defers to the request's own
 * hostname. Anything shaped like a UUID is an id; anything else is read as a hostname, which is also
 * where a literal `current` on a request carrying no `Host` header lands — deliberately unchanged
 * from what both call sites already did, rather than special-cased into a null.
 */
export async function resolveSiteParam(
  param: string,
  hostname: string | undefined,
  { strict = false }: { strict?: boolean } = {}
): Promise<any> {
  if (param === 'current' && hostname) {
    return siteForHostname(hostname, { strict })
  }
  if (isValidUuid(param)) {
    return WIKI.models.sites.getSiteById({ id: param })
  }
  return WIKI.models.sites.getSiteByHostname({ hostname: param, strict })
}

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
 * Fastify `preHandler`, registered once for the whole `/_api` tree in `api/index.ts`, that answers
 * both "no such site" and "site disabled" for every route whose path names `siteId`
 * (OpenProject #1587/#1593).
 *
 * Before this existed, the guard was nine hand-applied call sites (`bootstrap.ts`, three in
 * `pages.ts`, two in `assets.ts`, one in `graph.ts`, plus the three `controllers/` sites outside
 * `/_api`), which is how a dozen-plus other `:siteId` routes across `pages.ts` (GET PAGE, UNLOCK,
 * page history, the export routes), every read route in `tree.ts`, `assets.ts`'s upload/rename/
 * delete, and everything in `comments.ts`/`navigation.ts`/`liveData.ts`/`glossary.ts` went on
 * answering a disabled site's content indefinitely to a caller that already held its id. A single
 * plugin-level hook closes all of them at once, and a route file added later needs no call of its
 * own to be covered — it inherits this the moment it registers a route under `api/index.ts`.
 *
 * A plain, exported function rather than an inline `addHook` callback specifically so it can be
 * exercised directly, with a synthetic `req`/`reply`, against every `:siteId` route this instance
 * actually declares (`api/index.test.ts`) without booting a real HTTP server per route or hand-filling
 * each one's querystring/body schema just to get a request past validation and into the hook chain.
 *
 * The unknown-site `404` is the same consolidation one step further out. Thirty-six route handlers
 * across ten files opened with a hand-written site-existence preamble in two spellings — an `await
 * WIKI.models.sites.getSiteById(...)` (which is just `WIKI.sites[id]`, `models/sites.ts`) answering
 * `'Site does not exist.'`, and a bare `WIKI.sites[...]` lookup answering `'This site does not
 * exist.'` — while every OTHER `:siteId` route (all of `pages.ts`, `assets.ts`, `checklists.ts`,
 * `watching.ts`, `notifications.ts`, `graph.ts`, ...) simply never checked, answering "page does not
 * exist" or an empty list for a site id that was never real. One condition, checked in one place,
 * with one message (`SITE_MISSING_MESSAGE`): a route reached from here can assume its site exists,
 * and a route file added later inherits that the moment it registers under `api/index.ts`, exactly
 * as it already inherits the disabled-site 403.
 *
 * Hook ORDER decides which of the two answers a caller sees, and only for one class of route.
 * `index.ts`'s global permission `preHandler` is registered on the root app, so it runs BEFORE this
 * encapsulated one: a route declaring `config.permissions` still answers 401/403 first, and an
 * unauthorized caller learns nothing about which site ids exist. A route that declares none —
 * anything public, and every route that checks a page or `site:*` permission IN ITS HANDLER (which
 * that hook cannot express) — now answers this 404 BEFORE its own authorization runs, where it used
 * to 403 first or fall through to "page does not exist". That reordering is D1, not an oversight:
 * these routes are readable by an anonymous caller in the first place, so a site id's existence was
 * already discoverable through them.
 *
 * `req.params.siteId` reads as `undefined` on a route with no such param, which is neither a missing
 * site nor a disabled one — nothing to answer, so the request passes straight through.
 * `bootstrap.ts`'s own `guardSiteEnabled` call is the one deliberate exception this preHandler does
 * not subsume: that route resolves its site by hostname (`getSiteByHostname`), not a `:siteId` param,
 * so nothing keyed off `req.params.siteId` would ever reach it — its call stays in place.
 *
 * `api/sites.ts` is the other deliberate exception, by virtue of being registered outside the guarded
 * `contentApp` scope (see `api/index.ts`): its routes administer the site RECORD, keep their own
 * `'Site does not exist.'` 404s, and must go on working against a disabled site.
 */
export function siteEnabledPreHandler(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
): void {
  const siteId = (req.params as { siteId?: string } | undefined)?.siteId
  if (siteId) {
    if (!WIKI.sites[siteId]) {
      reply.notFound(SITE_MISSING_MESSAGE)
      return
    }
    if (guardSiteEnabled(WIKI.sites[siteId], reply)) {
      return
    }
  }
  done()
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
 * The locale content belongs to when a request does not say.
 *
 * A site always has a primary locale, and an instance that never turned locales on has exactly that
 * one — so this is the answer for most requests rather than a fallback. The single source for what
 * used to be three separately-maintained copies (`api/tree.ts`, `api/pages.ts`,
 * `models/pages.ts#defaultLocale`).
 */
export function defaultLocale(siteId: string): string {
  return WIKI.sites[siteId]?.config?.locales?.primary ?? 'en'
}

/**
 * Refuse a locale the site does not have enabled.
 *
 * A locale that used to be enabled and got turned off is not a valid target for content — not for a
 * page created there, not for one moved there, and not for one the deletion-recovery flow
 * (`pageHistory.recoverDeletedPage`) puts back. A site with no `active` list configured has exactly
 * its primary locale, which is why the fallback is that one code rather than "anything goes".
 *
 * @throws CustomError `pageInvalidLocale` (400) when the locale is not enabled on this site
 */
export function assertLocaleActive(siteId: string, locale: string): void {
  const activeLocales: string[] = WIKI.sites[siteId]?.config?.locales?.active ?? [
    defaultLocale(siteId)
  ]
  if (!activeLocales.includes(locale)) {
    throw new CustomError(
      'pageInvalidLocale',
      `This site does not have the "${locale}" locale enabled.`,
      400
    )
  }
}

/**
 * Refuse a page path whose FIRST segment is an installed locale code.
 *
 * `stripLocalePrefix` takes a locale code off the first segment of a URL and nowhere else, so a page
 * at `fr/guide` would be unreachable — every request for it would be read as `/guide` in French.
 * Only the first segment can collide; `guide/fr` is fine.
 *
 * @throws CustomError `pageReservedLocaleSegment` (400) when the first segment is an installed code
 */
export async function assertPathNotReservedLocale(path: string): Promise<void> {
  const firstSegment = path.split('/')[0] ?? ''
  if (await WIKI.models.locales.isReservedLocaleCode(firstSegment)) {
    throw new CustomError(
      'pageReservedLocaleSegment',
      `"${firstSegment}" is an installed locale code and cannot begin a page path.`,
      400
    )
  }
}

/**
 * Find a candidate locale code's canonically-cased form within a site's active list, matching
 * case-insensitively. A link or query string can carry a code in any casing (`/FR/page`,
 * `?locale=FR`), but everything downstream — storage, comparison, the path a redirect lands on —
 * works off the casing `active` itself stores, never the request's own. Returns null when nothing
 * in `active` matches.
 */
export function matchLocaleCode(candidate: string, active?: string[] | null): string | null {
  if (!active || active.length < 1) {
    return null
  }
  const lower = candidate.toLowerCase()
  return active.find((code) => code.toLowerCase() === lower) ?? null
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
  const match = matchLocaleCode(firstSegment, locales.active)
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
 * (`bg/`, `fonts/`, `icons/`, `illustrations/`, `logo-wikijs.svg`, `storage/`, `svg/`), are exactly
 * the entries this returns `false` for.
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
 * Get default value of type
 *
 * @param type primitive type name
 * @returns Default value
 */
function getTypeDefaultValue(type: string): string | number | boolean | undefined {
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

/**
 * Placeholder returned in place of a module-config prop declared `sensitive: true`, once it holds a
 * real value -- mirrors `PASSWORD_MASK` in `api/mail.ts`, which predates `ModuleProp` and stores the
 * SMTP password as a single flat config rather than a per-module prop list.
 */
export const SENSITIVE_CONFIG_MASK = '********'

/**
 * Replace every `sensitive` prop's stored value with `SENSITIVE_CONFIG_MASK`, for a config about to
 * leave the server -- an admin API response, a log line, anything a caller might see. A prop with
 * nothing stored (`''`, `null`, `undefined`) is left alone: there is no secret to hide, and masking
 * it would make the admin form show a password field as "already set" when it isn't.
 *
 * Deliberately not applied inside a model's own merge (`buildConfig`/`buildEngineConfig`), nor to a
 * config handed to a module's own implementation to actually connect with -- storage's
 * `dispatch()`/`executeAction()`/`runDailyBackups()` and search's `selectEngine()`/
 * `initActiveEngines()` all need the real value to function. Call sites choose this explicitly (an
 * admin list/detail route serializing straight to JSON), never as a read method's default.
 */
export function maskSensitiveConfig(
  props: Record<string, ModuleProp>,
  config: Record<string, any>
): Record<string, any> {
  const masked: Record<string, any> = { ...config }
  for (const [key, prop] of Object.entries(props)) {
    if (prop.sensitive && typeof masked[key] === 'string' && masked[key].length > 0) {
      masked[key] = SENSITIVE_CONFIG_MASK
    }
  }
  return masked
}

/**
 * Drop a `sensitive` prop's value from `incoming` when it is exactly `SENSITIVE_CONFIG_MASK` -- an
 * admin form redisplaying a masked value it was never asked to change echoes it straight back on the
 * next save. Called on the way in, before a merge such as `buildConfig`'s own `incoming[key] ===
 * undefined ? current : incoming[key]` falls back to whatever is already stored, so a save that
 * leaves a password field untouched can never overwrite the real secret with the mask string itself.
 */
export function unmaskSensitiveConfig(
  props: Record<string, ModuleProp>,
  incoming: Record<string, any>
): Record<string, any> {
  const unmasked: Record<string, any> = { ...incoming }
  for (const [key, prop] of Object.entries(props)) {
    if (prop.sensitive && unmasked[key] === SENSITIVE_CONFIG_MASK) {
      delete unmasked[key]
    }
  }
  return unmasked
}

/**
 * A file's bytes only change when this codebase's own on-disk contents change (a redeploy — a new
 * build, a new process), never in response to a request, so there is no per-instance revalidation
 * problem to solve for it and a long `max-age` is safe: this is not hash-named content though, so it
 * still needs a validator for the rare case a client does revalidate (a forced reload, or the
 * `max-age` window elapsing) to pick up a redeploy's new bytes without a full re-download.
 */
const REPLY_WITH_FILE_CACHE = 'public, max-age=86400'

export async function replyWithFile(
  req: FastifyRequest,
  reply: FastifyReply,
  filePath: string
): Promise<FastifyReply> {
  const stats = await fsp.stat(filePath)
  // -> Weak because it's derived from size+mtime rather than the file's actual bytes — cheap to
  //    compute (no read/hash of the file itself) and sufficient: the only thing that can change
  //    these bytes is a redeploy, which always touches both.
  const etag = `W/"${stats.size}-${stats.mtimeMs}"`
  reply.header('Content-Type', mime.getType(filePath))
  reply.header('Cache-Control', REPLY_WITH_FILE_CACHE)
  reply.header('ETag', etag)
  reply.header('Last-Modified', stats.mtime.toUTCString())
  if (req.headers['if-none-match'] === etag) {
    return reply.code(304).send()
  }
  const stream = fs.createReadStream(filePath)
  return reply.send(stream)
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
