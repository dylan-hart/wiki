import type { LogFields } from '../core/logger.ts'

/**
 * The slice of a Fastify request the log-context builders below read — a structural subset of
 * `FastifyRequest`, kept narrow so these stay pure functions with no Fastify (or `WIKI`) dependency
 * to construct in a test.
 */
export interface RequestLogContextRequest {
  id: string
  /** Untyped by Fastify itself unless a route declares a `Params` generic — see `siteId` below. */
  params?: unknown
  /** Set by `core/http/siteRouting.ts`'s site-resolution hook, for a page/shell request only. */
  site?: { id?: string } | null
  session?: {
    authenticated?: boolean
    user?: { id?: string } | null
  } | null
}

/**
 * The slice `setErrorHandler`'s bare-500 branch needs: the above, plus the method and URL that the
 * access line already spells out in its own message and so does not repeat as fields.
 */
export interface ErrorLogContextRequest extends RequestLogContextRequest {
  method: string
  url: string
}

/**
 * The identity a log line about a request carries: which request it was, whose session it ran under,
 * and which site it landed on.
 *
 * One derivation, two callers — `core/http/server.ts`'s `onResponse` access line (which adds `ms` and
 * `ip`) and `buildErrorLogContext` below (which adds `method` and `url`). Extracted so the two cannot
 * drift: an operator correlating a 500's stack with its access line by `reqId` needs both to have
 * decided `userId` and `siteId` the same way.
 *
 * `siteId` is best-effort. `req.site` is set by `core/http/siteRouting.ts`'s site-resolution hook and
 * is the right answer for a page or app-shell request, but it is never populated for an `/_api/*`
 * one — `isPageUrl` excludes anything under a leading-underscore segment. A `:siteId` route param is
 * therefore checked first, since that is what a site-scoped API route carries, and the resolved site
 * is the fallback; where neither exists this stays `undefined` rather than guessing (OpenProject
 * #1937).
 */
export function buildRequestLogContext(req: RequestLogContextRequest): LogFields {
  const params = req.params as Record<string, unknown> | undefined
  const paramSiteId = typeof params?.siteId === 'string' ? params.siteId : undefined
  const resolvedSiteId = typeof req.site?.id === 'string' ? req.site.id : undefined
  const userId = req.session?.authenticated ? (req.session.user?.id ?? undefined) : undefined

  return {
    reqId: req.id,
    siteId: paramSiteId ?? resolvedSiteId,
    userId
  }
}

/**
 * Builds the structured context attached to an unhandled-error log line, so a 500 can be traced back
 * to the request that caused it purely from the log (OpenProject #1937) — `helpers/errorHandler.ts`'s
 * bare-500 branch passes this alongside the error itself.
 *
 * `method`/`url` are its own two fields; everything else is `buildRequestLogContext` above, shared
 * with the `http` access line the same request also produces.
 */
export function buildErrorLogContext(req: ErrorLogContextRequest): LogFields {
  const { reqId, siteId, userId } = buildRequestLogContext(req)

  return {
    reqId,
    method: req.method,
    url: req.url,
    siteId,
    userId
  }
}
