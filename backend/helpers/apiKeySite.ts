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
 * A small reusable helper rather than inline logic in one route, so that Epic 11 (or a later Feature
 * 395 task) can drop the same one-line guard into the rest of the site-scoped surface — `api/
 * assets.ts`'s asset routes, page history, page moves, and so on — without re-deriving this. See the
 * task's own description for the enumeration of what is deliberately left uncovered here.
 *
 * `req.params.siteId` isn't the only shape a route resolves its site from — some resolve it from
 * `req.hostname` (`controllers/files.ts`, `controllers/site.ts`), and are called here explicitly for
 * exactly that reason (OpenProject #2201). A third shape — a site id named in the request *body*,
 * used by every `manage:system`-gated admin route that creates or exports something scoped to one
 * site (`api/hooks.ts`'s webhook create/update, `api/apiKeys.ts`'s admin-issued key create, `api/
 * system.ts`'s `/export`) — is deliberately left *uncalled*, not merely unenumerated: `manage:system`
 * already bypasses every other authorization check in this codebase (see CLAUDE.md's Permissions
 * section), so pinning would be enforced only on this one action a `manage:system` key can take and
 * nowhere else it matters just as much — an inconsistent partial boundary rather than a real one. Each
 * such route carries a comment pointing back here instead of a call.
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
