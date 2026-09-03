import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Refuse a request whose API key is scoped to one site but whose resource belongs to another.
 *
 * `apiKeys.siteId` (added alongside this feature — see `models/apiKeys.ts`) is nullable, and null
 * means unrestricted: a key with no site on it may act against any site, exactly as every key did
 * before `siteId` existed. Only a *non-null* `req.apiKey.siteId` is a restriction, and it is checked
 * against `siteId`, the id of the site the route is actually about.
 *
 * A request with no API key at all (session auth, or no auth) is not this helper's concern and always
 * passes — it only ever restricts what an API key, specifically, may reach.
 *
 * Returns `true` when the request may proceed. On a mismatch it writes the 403 itself (via
 * `reply.forbidden()`, matching every other authorization refusal in `api/pages/read.ts` and
 * `api/assets.ts`) and returns `false`, so a caller's whole check is:
 *
 * ```ts
 * if (!enforceApiKeySite(req, reply, req.body.siteId)) {
 *   return reply
 * }
 * ```
 *
 * Most of the `/sites/:siteId/...` REST surface never calls this directly any more — `apiKeySitePinHook`
 * below is registered once, globally, in `index.ts` and covers all of it. It stays exported, and is
 * still called explicitly, for the handful of routes that resolve their site some other way than a
 * `:siteId` path parameter under that hook's prefix:
 *   - `req.hostname` (`controllers/files.ts`, `controllers/site.ts`, `controllers/render.ts` —
 *     OpenProject #2201), where the route has to resolve the real site itself before this can run;
 *   - a site id named in the request *body*, used by every `manage:system`-gated admin route that
 *     creates or exports something scoped to one site (`api/hooks.ts`'s webhook create/update,
 *     `api/apiKeys.ts`'s admin-issued key create, `api/system/transfer.ts`'s `/export`) — deliberately left
 *     *uncalled*, not merely unenumerated: `manage:system` already bypasses every other authorization
 *     check in this codebase (see CLAUDE.md's Permissions section), so pinning would be enforced only
 *     on this one action a `manage:system` key can take and nowhere else it matters just as much — an
 *     inconsistent partial boundary rather than a real one. Each such route carries a comment pointing
 *     back here instead of a call.
 *
 * `mcp/auth.ts`'s `assertSiteInScope` re-implements the same check rather than calling this, since it
 * throws instead of writing a Fastify reply.
 */
export function enforceApiKeySite(
  req: FastifyRequest,
  reply: FastifyReply,
  siteId: string
): boolean {
  if (req.apiKey?.siteId && req.apiKey.siteId !== siteId) {
    reply.forbidden('This API key is not scoped to this site.')
    return false
  }
  return true
}

/**
 * The URL prefixes a Bearer token is actually verified against, in `index.ts`'s own `onRequest` hook
 * (the one that sets `req.apiKey`). `/_api/` is the ordinary case. The other three are the
 * hostname-resolved, no-`:siteId`-param controllers this file's own doc comment above names
 * (`controllers/files.ts`, `controllers/site.ts`) plus `controllers/thumb.ts` — which reads
 * `req.apiKey` indirectly, through `actorForRequest()`'s `AccessActor.siteId` and
 * `groups.checkAccess()`'s `withinSitePin`, rather than calling `enforceApiKeySite()` itself, but
 * depends on `req.apiKey` being populated exactly the same way (OpenProject #2339: before this
 * existed, `req.apiKey` was always null outside `/_api/`, so every one of these checks was a
 * permanent no-op for a Bearer-authenticated request against any of them).
 *
 * Deliberately excludes two look-alike public controllers: `controllers/render.ts` resolves no site
 * at all (the served shell is identical for every site) and is only ever fetched by this instance's
 * own headless browser, which carries no API key; `controllers/icons.ts` never reads `req.apiKey` —
 * an icon carries no site-scoped permission of its own to check.
 */
const BEARER_AUTH_PREFIXES = ['/_api/', '/_files/', '/_site/', '/_thumb/']

/**
 * Whether `index.ts`'s API-key-verification hook should even look for a Bearer token on this
 * request. Kept as a plain function of the URL, matching `helpers/rateLimit.ts#isPublicRateLimitedPath`'s
 * own reasoning for being one: independently unit-testable, with no Fastify instance needed.
 */
export function isBearerAuthenticatedPath(url: string): boolean {
  return BEARER_AUTH_PREFIXES.some((prefix) => url.startsWith(prefix))
}

/**
 * The literal prefix every `/sites/:siteId/...` REST route is mounted under: `api/index.ts` registers
 * every resource file (`pages.ts`, `assets.ts`, `sites.ts`, `tree.ts`, ...) under `/_api`, and each one
 * writes its own path starting with either `/sites/:siteId/...` or (`sites.ts` itself, whose file
 * writes bare `/:siteId/...` under an `{ prefix: '/sites' }` registration) the same thing once the
 * prefix is applied. `helpers/apiKeySite.coverage.test.ts` asserts, against the real registered route
 * table, that this really is every route carrying a `:siteId` param — so a route added under some
 * other prefix that still happens to read a `:siteId` param (paths OUTSIDE this prefix that also
 * happen to have a same-named parameter — `controllers/site.ts`'s `/:siteId/:resource`, whose
 * `:siteId` can be the literal sentinel `'current'` or a hostname rather than a real site id — are
 * deliberately NOT matched by this prefix, and must call `enforceApiKeySite()` explicitly instead)
 * fails that test rather than silently going unchecked.
 */
const SITE_SCOPED_API_PREFIX = '/_api/sites/'

/**
 * Global `preHandler` enforcing the API key `siteId` pin across every `/sites/:siteId/...` REST route
 * in one place (OpenProject #2194), rather than the one-liner-per-route approach that produced the gap
 * this closes: `enforceApiKeySite()` above was invoked at exactly two of 117+ call sites before this
 * existed. Registered once in `index.ts`, beside the permissions hook, so a route added later under
 * `SITE_SCOPED_API_PREFIX` is covered automatically rather than by remembering to add a call. Routes
 * with no `:siteId` param under that prefix are untouched, matching `enforceApiKeySite`'s own "no
 * opinion when there is nothing to check" behavior for a request with no API key at all.
 *
 * Cheap on the overwhelming majority of requests: an unpinned key (`req.apiKey.siteId` null, or no key
 * at all — session auth, or none) returns before even looking at the URL.
 */
export function apiKeySitePinHook(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
): void {
  if (!req.apiKey?.siteId) {
    return done()
  }
  if (!req.url.startsWith(SITE_SCOPED_API_PREFIX)) {
    return done()
  }
  const siteId = (req.params as { siteId?: string } | undefined)?.siteId
  if (siteId && !enforceApiKeySite(req, reply, siteId)) {
    // -> enforceApiKeySite() already wrote the 403; do not call done() again.
    return
  }
  done()
}
