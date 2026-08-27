import type { FastifyReply } from 'fastify'

/**
 * The non-`/_api` branch of the global `app.setErrorHandler` in `index.ts` (task 2263).
 *
 * The `/_api` branch already answers a fixed `{ ok, error, statusCode, message }` body for an
 * uncaught error, but everything else -- `controllers/render.ts`, `thumb.ts`, `site.ts`, `icons.ts`,
 * `blocks.ts`, `seo.ts`, `files.ts`, every one reachable without a session -- used to fall to a bare
 * `reply.send(error)`. Sending an `Error` from inside a custom error handler re-enters Fastify's own
 * `handleError` and lands at its `fallbackErrorHandler`, which serialises
 * `{ statusCode, code: error.code, message: error.message }` verbatim. `controllers/files.ts`'s
 * uncaught `WIKI.models.assets.readContent()` is the concrete case this closes: an `ENOENT`/`EACCES`
 * there used to hand an unauthenticated client the absolute deployment path, and a Drizzle/pg
 * failure anywhere in this branch used to hand back raw SQL text naming tables and columns.
 *
 * An error carrying a `statusCode` was set deliberately -- almost always through `@fastify/sensible`
 * (`reply.notFound()`, `reply.forbidden()`, `app.httpErrors.*`, ...), whose messages are curated for
 * disclosure -- so it is answered as-is. Anything else collapses to a fixed generic body carrying no
 * `error.message`/`error.code` text.
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

/**
 * Pure computation of the non-`/_api` error response -- no Fastify instance needed to test it.
 */
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
 * The actual non-`/_api` error handler `index.ts` wires into `app.setErrorHandler`. Logs every such
 * error through `WIKI.logger.warn` -- previously these throws reached only Fastify's own pino
 * instance (`index.ts`'s logger option), so they were missing from the admin terminal stream and its
 * backlog -- then answers with `buildNonApiErrorResponse`'s fixed body.
 */
export function sendNonApiError(error: any, reply: FastifyReply): void {
  WIKI.logger.warn(error)
  const { statusCode, body } = buildNonApiErrorResponse(error)
  reply.code(statusCode).type('application/json').send(body)
}
