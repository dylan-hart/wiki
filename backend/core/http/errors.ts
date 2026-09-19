import type { FastifyInstance } from 'fastify'

import { apiErrorHandler, sendNonApiError } from '../../helpers/errorHandler.ts'

/**
 * Both branches live in `helpers/errorHandler.ts`, so a test harness can install the real `/_api/`
 * one rather than re-writing it.
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
