import type { LogFields } from '../core/logger.ts'

/** A structural subset of `FastifyRequest`, so the builders below stay pure and Fastify-free. */
export interface RequestLogContextRequest {
  id: string
  params?: unknown
  /** Set by `core/http/siteRouting.ts`'s site-resolution hook, for a page/shell request only. */
  site?: { id?: string } | null
  session?: {
    authenticated?: boolean
    user?: { id?: string } | null
  } | null
}

export interface ErrorLogContextRequest extends RequestLogContextRequest {
  method: string
  url: string
}

/**
 * One derivation shared by the access line and the unhandled-error line, so an operator correlating
 * the two by `reqId` finds `userId` and `siteId` decided the same way.
 *
 * `siteId` is best-effort: `req.site` is never populated for an `/_api/*` request, so a `:siteId`
 * route param is checked first and the resolved site is the fallback.
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

/** Adds `method`/`url`, which the access line carries in its message rather than as fields. */
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
