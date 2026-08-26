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
 * `apiKeySitePinHook` below wraps this into the global `preHandler` (registered in `index.ts`
 * alongside the permissions hook — task 2194) that applies it automatically to every
 * `/sites/:siteId/...` route, so no route needs to call this directly for that shape any more. It
 * stays exported as the hook's own implementation and for `helpers/apiKeySite.test.ts` to unit-test
 * the comparison in isolation.
 *
 * `req.params.siteId` isn't the only shape a route resolves its site from, and the hook only ever
 * looks at that one param — two other shapes still call this (or its equivalent) directly:
 *   - `req.hostname` (`controllers/files.ts`, `controllers/site.ts` — OpenProject #2201), where the
 *     route has to resolve the real site itself before this can run;
 *   - a site id named in the request *body*, used by every `manage:system`-gated admin route that
 *     creates or exports something scoped to one site (`api/hooks.ts`'s webhook create/update,
 *     `api/apiKeys.ts`'s admin-issued key create, `api/system.ts`'s `/export`) — deliberately left
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
 * The global `preHandler` hook (`index.ts`, registered alongside the permissions hook) that applies
 * `enforceApiKeySite` to *every* route, not just the ones that remember to call it — see task 2194.
 *
 * A route is "covered" simply by having a `:siteId` in its path; there is no per-route allow-list to
 * keep in sync, so a newly added `/sites/:siteId/...` route is guarded automatically. Routes with no
 * `:siteId` param (`req.params.siteId` undefined) are untouched, matching `enforceApiKeySite`'s own
 * "no opinion when there is nothing to check" behavior for a request with no API key at all.
 */
export function apiKeySitePinHook(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
): void {
  const siteId = (req.params as Record<string, string | undefined> | undefined)?.siteId
  if (siteId && !enforceApiKeySite(req, reply, siteId)) {
    return
  }
  done()
}
