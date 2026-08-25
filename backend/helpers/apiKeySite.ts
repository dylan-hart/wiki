import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Refuse a request whose API key is scoped to one site but whose resource belongs to another.
 *
 * `apiKeys.siteId` (added alongside this feature — see `models/apiKeys.ts`) is nullable, and null
 * means unrestricted: a key with no site on it may act against any site, exactly as every key did
 * before `siteId` existed. Only a *non-null* `req.apiKey.siteId` is a restriction, and it is checked
 * against `siteId`, the id of the site the route is actually about — usually `req.params.siteId`
 * lifted straight off the URL, since a route addressed as `/sites/:siteId/...` already resolves its
 * resource against that id and needs no further lookup to know it.
 *
 * A request with no API key at all (session auth, or no auth) is not this helper's concern and always
 * passes — it only ever restricts what an API key, specifically, may reach.
 *
 * Returns `true` when the request may proceed. On a mismatch it writes the 403 itself (via
 * `reply.forbidden()`, matching every other authorization refusal in `api/pages.ts` and
 * `api/assets.ts`) and returns `false`, so a caller's whole check is:
 *
 * ```ts
 * if (!enforceApiKeySite(req, reply, req.params.siteId)) {
 *   return reply
 * }
 * ```
 *
 * Most of the `/sites/:siteId/...` REST surface never calls this directly any more — `apiKeySitePinHook`
 * below is registered once, globally, in `index.ts` and covers all of it. This stays exported, and is
 * still called explicitly, for the handful of routes that resolve their site some other way than a
 * `:siteId` path parameter — a hostname (`controllers/files.ts`, `controllers/site.ts`,
 * `controllers/render.ts`) or a request body — which the params-only hook cannot see (OpenProject
 * #2201).
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
 * The literal prefix every `/sites/:siteId/...` REST route is mounted under: `api/index.ts` registers
 * every resource file (`pages.ts`, `assets.ts`, `sites.ts`, `tree.ts`, ...) under `/_api`, and each one
 * writes its own path starting with either `/sites/:siteId/...` or (`sites.ts` itself, whose file
 * writes bare `/:siteId/...` under an `{ prefix: '/sites' }` registration) the same thing once the
 * prefix is applied. `test/apiKeySitePinCoverage.test.ts` asserts, against the real registered route
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
 * `SITE_SCOPED_API_PREFIX` is covered automatically rather than by remembering to add a call.
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
