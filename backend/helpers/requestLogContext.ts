import type { LogFields } from '../core/logger.ts'

/**
 * The slice of a Fastify request `setErrorHandler`'s bare-500 branch needs to build a log context
 * from — a structural subset of `FastifyRequest`, kept narrow so this stays a pure function with no
 * Fastify (or `WIKI`) dependency to construct in a test.
 */
export interface ErrorLogContextRequest {
  id: string
  method: string
  url: string
  /** Untyped by Fastify itself unless a route declares a `Params` generic — see `siteId` below. */
  params?: unknown
  session?: {
    authenticated?: boolean
    user?: { id?: string } | null
  } | null
}

/**
 * Builds the structured context attached to an unhandled-error log line, so a 500 can be traced back
 * to the request that caused it purely from the log (OpenProject #1937) — `index.ts`'s
 * `apiErrorHandler` spreads it into the fields of one
 * `WIKI.logger.error('http', 'unhandled error, answered 500', { error, ... })` call.
 *
 * `siteId` is best-effort: `req.site` (set by `index.ts`'s site-resolution hook) is never populated
 * for an `/_api/*` request — `isPageUrl` excludes anything under a leading-underscore segment — so
 * there is no single request-wide site to read here. This falls back to a `:siteId` route param when
 * the failing route happens to be site-scoped, and leaves it `undefined` otherwise rather than
 * guessing at one.
 */
export function buildErrorLogContext(req: ErrorLogContextRequest): LogFields {
  const params = req.params as Record<string, unknown> | undefined
  const siteId = typeof params?.siteId === 'string' ? params.siteId : undefined
  const userId = req.session?.authenticated ? (req.session.user?.id ?? undefined) : undefined

  return {
    reqId: req.id,
    method: req.method,
    url: req.url,
    siteId,
    userId
  }
}
