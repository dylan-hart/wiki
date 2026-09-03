import type { FastifyInstance } from 'fastify'

import { apiErrorHandler, sendNonApiError } from '../../helpers/errorHandler.ts'

/**
 * The one global error handler, split by surface: `/_api/` answers the documented
 * `{ ok, error, statusCode, message }` JSON body, everything else (the static/asset controllers,
 * reachable without a session) answers the disclosure-safe body `sendNonApiError` builds.
 *
 * Both branches live in `helpers/errorHandler.ts`, so a test harness can install the real one rather
 * than re-writing it (TEST-F2).
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: any, req, reply) => {
    if (req.url.includes('/_api/')) {
      apiErrorHandler(error, req, reply)
    } else {
      sendNonApiError(error, reply)
    }
  })
}
