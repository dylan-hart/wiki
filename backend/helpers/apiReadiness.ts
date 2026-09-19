import type { FastifyReply, FastifyRequest } from 'fastify'

export const API_NOT_READY_MESSAGE = 'The server is still starting up. Try again in a moment.'

/** A courtesy hint, not an estimate: `postBoot()` normally finishes well under a second after
 * `app.listen()`. */
export const API_NOT_READY_RETRY_AFTER_SECONDS = 1

/**
 * Answers 503 for the window between `app.listen()` accepting connections and `postBoot()`
 * finishing, where a route would otherwise serve empty or incomplete data. The window exists because
 * `/_live` has to answer while the process is merely alive, so `app.listen()` cannot wait for
 * `postBoot()`. `isReady()` is the flag `/_ready` answers from, so this also 503s during shutdown.
 *
 * Returns `true` once a reply has been sent.
 */
export function guardApiReady(reply: Pick<FastifyReply, 'header' | 'serviceUnavailable'>): boolean {
  if (CARDINAL.server.isReady()) {
    return false
  }
  reply.header('Retry-After', String(API_NOT_READY_RETRY_AFTER_SECONDS))
  reply.serviceUnavailable(API_NOT_READY_MESSAGE)
  return true
}

/**
 * `onRequest`, not `preHandler`: it needs no route param, and refusing this early skips body parsing
 * and the permission `preHandler`.
 */
export async function apiReadinessOnRequest(
  _req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  guardApiReady(reply)
}
