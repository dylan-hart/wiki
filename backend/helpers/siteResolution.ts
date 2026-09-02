import type { FastifyReply, FastifyRequest } from 'fastify'

import { isValidUuid } from './common.ts'

/** What a page/shell request's hostname resolved to, for the site-resolution hook in `core/http/siteRouting.ts`. */
export type RequestSiteResolution =
  | { outcome: 'exempt' }
  | { outcome: 'not-found' }
  | { outcome: 'disabled'; site: Record<string, any> }
  | { outcome: 'ok'; site: Record<string, any> }

/**
 * Decide what a page/shell request's hostname resolves to, and whether the request should be let
 * through at all.
 *
 * Mirrors the SEO hook's precedence in `core/http/siteRouting.ts` exactly — `sitesMappings[normalizeHostname(hostname)]
 * || sitesMappings['*']` — so a request sees the same site the SEO hook already used to decide
 * whether to strip a page extension.
 *
 * `exemptSegments` is the caller's list of first path segments that must reach the app shell
 * regardless of what the hostname resolves to — the fix path for a disabled or unmatched site has to
 * survive the very thing it exists to correct.
 *
 * `hostname` is trusted as-is here — the refusal of a forwarded host that names a different site than
 * the socket's own `Host` (task 2085, `docs/audit-2026-08-24/security/13-tenancy-isolation.md` §6)
 * happens one layer up, in Fastify itself: `core/http/server.ts` passes `security.trustProxy` straight through
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

/**
 * Response contract for a site resolved OUTSIDE the page/shell hook in `core/http/siteRouting.ts` — an API route or
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
