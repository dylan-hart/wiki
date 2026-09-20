import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * A null `req.apiKey.siteId` means unrestricted, and a request with no API key always passes. On a
 * mismatch this writes the 403 itself and returns `false`, so the caller returns `reply`.
 *
 * `apiKeySitePinHook` covers the `/_api/sites/:siteId/...` surface; call this directly only where
 * the site is resolved some other way (a hostname, a query-string id). A body `siteId` on a
 * `manage:system`-gated route is deliberately left unchecked: `manage:system` bypasses every other
 * authorization check, so pinning that one action would be an inconsistent partial boundary.
 *
 * Mirrored by `mcp/auth.ts#assertSiteInScope`, which throws instead of writing a reply.
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
 * The prefixes `core/http/authHooks.ts` verifies a Bearer token under; anywhere else `req.apiKey`
 * stays unset and a site-pin check is a silent no-op. Beyond `/_api/`, these are the
 * hostname-resolved controllers that read `req.apiKey`, directly or through `actorForRequest()`.
 *
 * `/_render/` and `/_icons/` are deliberately absent: the render shell resolves no site and is only
 * fetched by this instance's own headless browser, and an icon has no site-scoped permission to
 * check.
 */
const BEARER_AUTH_PREFIXES = ['/_api/', '/_files/', '/_site/', '/_thumb/', '/_pages/']

export function isBearerAuthenticatedPath(url: string): boolean {
  return BEARER_AUTH_PREFIXES.some((prefix) => url.startsWith(prefix))
}

/**
 * `apiKeySite.coverage.test.ts` asserts, against the real route table, that every `/_api` route with
 * a `:siteId` param sits under this prefix. A route outside it that shares the param name
 * (`controllers/site.ts`, whose `:siteId` may be `'current'` or a hostname) is deliberately not
 * matched and calls `enforceApiKeySite()` itself.
 */
const SITE_SCOPED_API_PREFIX = '/_api/sites/'

/**
 * One global `preHandler` rather than a call per route, so a route added later under
 * `SITE_SCOPED_API_PREFIX` is covered without anyone remembering to.
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
