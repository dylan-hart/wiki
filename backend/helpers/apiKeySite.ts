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
 * `reply.forbidden()`, matching every other authorization refusal in `api/pages.ts` and
 * `api/assets.ts`) and returns `false`, so a caller's whole check is:
 *
 * ```ts
 * if (!enforceApiKeySite(req, reply, req.body.siteId)) {
 *   return reply
 * }
 * ```
 *
 * OpenProject #2189/#2194: EVERY `/sites/:siteId/...` route is now covered automatically by
 * `apiKeySitePinPreHandler()` below, registered once as a global `preHandler` in `index.ts` — that
 * is what closed the gap this helper's own doc comment used to describe as future work (117 routes,
 * 2 of them remembering to call this). This direct function stays exported, and still has to be
 * called explicitly, ONLY for the handful of routes that resolve the site they act on from
 * somewhere other than `req.params.siteId` — a request body or querystring field, since the global
 * hook has no way to know which field on an arbitrary route means "the site" (`api/system.ts`'s
 * `/export`/`/import` are the two today). A route addressed as `/sites/:siteId/...` needs no call
 * to this at all: the global hook already covers it.
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
 * The global preHandler `index.ts` registers once, covering every `/sites/:siteId/...` route at
 * once rather than requiring each one to remember its own `enforceApiKeySite()` call — the shape
 * the fix deliberately avoided (OpenProject #2189's own audit finding was exactly that the
 * route-by-route approach produced a 2-of-117 gap).
 *
 * Reads `siteId` off `req.params` the plain way (`(req.params as any)?.siteId`) rather than typing
 * every possible route's params shape: this runs before any one route's own generic narrows
 * `req.params`, so it has to work across the whole app. A route with no `:siteId` segment at all —
 * the overwhelming majority under `/_api/` that address a group, a user, the instance itself — has
 * no `siteId` here and this is a no-op for it, exactly as `enforceApiKeySite()` already was for a
 * caller that had nothing to check against.
 */
export function apiKeySitePinPreHandler(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
): void {
  const targetSiteId = (req.params as Record<string, unknown> | undefined)?.siteId
  if (
    req.apiKey?.siteId &&
    typeof targetSiteId === 'string' &&
    req.apiKey.siteId !== targetSiteId
  ) {
    reply.forbidden('This API key is not scoped to this site.')
    return
  }
  done()
}
