import type { FastifyReply, FastifyRequest } from 'fastify'
import { buildErrorLogContext } from './requestLogContext.ts'

/**
 * The non-`/_api` branch of `core/http/errors.ts`'s `setErrorHandler`. A bare `reply.send(error)`
 * from inside a custom error handler lands at Fastify's `fallbackErrorHandler`, which serialises
 * `error.code`/`error.message` verbatim -- on routes reachable without a session, that discloses an
 * `ENOENT`'s absolute path or a pg failure's raw SQL text.
 *
 * An error carrying a `statusCode` was set deliberately -- almost always through
 * `@fastify/sensible`, whose messages are curated for disclosure -- so it is answered as-is.
 * Anything else collapses to a fixed generic body carrying no `error.message`/`error.code` text.
 */
export interface NonApiErrorBody {
  ok: false
  error: string
  statusCode: number
  message: string
}

export interface NonApiErrorResponse {
  statusCode: number
  body: NonApiErrorBody
}

/** Pure, so it is testable with no Fastify instance. */
export function buildNonApiErrorResponse(error: any): NonApiErrorResponse {
  if (error?.statusCode) {
    return {
      statusCode: error.statusCode,
      body: {
        ok: false,
        error: error.name,
        statusCode: error.statusCode,
        message: error.message
      }
    }
  }
  return {
    statusCode: 500,
    body: {
      ok: false,
      error: 'Internal Server Error',
      statusCode: 500,
      message: 'Internal Server error'
    }
  }
}

/**
 * Only an error with no `statusCode` is logged, as in `apiErrorHandler`: a deliberate 4xx is
 * routine, and logging each one floods the log. It logs at `error`, not `warn` -- a request that
 * ended in an unhandled exception is what an operator alerting on `error` must see.
 */
export function sendNonApiError(error: any, reply: FastifyReply): void {
  if (!error?.statusCode) {
    CARDINAL.logger.error('http', 'unhandled error outside /_api', { error })
  }
  const { statusCode, body } = buildNonApiErrorResponse(error)
  reply.code(statusCode).type('application/json').send(body)
}

/**
 * The `/_api` branch, standalone so the real handler can be installed anywhere `/_api/` routes are
 * served -- a test harness included. As above, only an error with no `statusCode` is a bug and logs.
 */
export function apiErrorHandler(error: any, req: FastifyRequest, reply: FastifyReply): void {
  if (error.statusCode) {
    reply.code(error.statusCode).type('application/json').send({
      ok: false,
      error: error.name,
      statusCode: error.statusCode,
      message: error.message
    })
  } else {
    // -> The request context carries `req.id`, the correlation id Fastify's own access log has for
    //    this request, so the two lines join in an aggregator. `error`, not `warn`: a bug that
    //    answered a client 500 is what an operator alerting on `error` must be woken by.
    CARDINAL.logger.error('http', 'unhandled error, answered 500', {
      error,
      ...buildErrorLogContext(req)
    })
    reply.code(500).type('application/json').send({
      ok: false,
      error: 'Internal Server Error',
      statusCode: 500,
      message: 'Internal Server error'
    })
  }
}
