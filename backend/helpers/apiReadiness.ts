import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * The message every `/_api` request answers with while `postBoot()` has not finished yet — see
 * `guardApiReady` below.
 */
export const API_NOT_READY_MESSAGE = 'The server is still starting up. Try again in a moment.'

/** The `Retry-After` (seconds) sent alongside `API_NOT_READY_MESSAGE`. `postBoot()` normally finishes
 * in well under a second past `app.listen()`, so this is a courtesy hint for a caller that honours
 * it, not a real estimate of remaining work. */
export const API_NOT_READY_RETRY_AFTER_SECONDS = 1

/**
 * Answers `503` (with a `Retry-After` hint) in place of letting a `/_api` request reach a route at
 * all, for the window between `app.listen()` accepting connections and `postBoot()` finishing
 * (OpenProject #3322).
 *
 * `index.ts`'s own boot comment already documents why that window exists: `/_live` has to answer
 * while the process is merely alive, so delaying `app.listen()` itself until after `postBoot()` would
 * silence that liveness probe along with the readiness window it exists to survive. Gating on
 * `CARDINAL.server.isReady()` here instead keeps that split intact — a request landing in the window
 * gets a clear "come back in a moment" instead of empty/incomplete data (e.g. `GET
 * authentication/modules` answering `[]`, Admin Authentication showing no modules until a manual
 * Refresh happens to land after `postBoot()` has since finished). `isReady()` is the same flag
 * `/_ready` itself answers off (`core/http/shutdown.ts`), so this also naturally 503s during shutdown,
 * once teardown has started and `isReady()` flips back to `false`.
 *
 * Uses `reply.serviceUnavailable()` — the same `@fastify/sensible` convention `helpers/rateLimit.ts`
 * already uses for its `Retry-After` + `429` pair — so the response body ends up shaped by the real
 * `apiErrorHandler` (`{ ok, error, statusCode, message }`) rather than a second, hand-written literal.
 *
 * Returns `true` once a reply has been sent, matching `guardSiteEnabled`'s own convention — a caller
 * driving this directly (rather than through `apiReadinessOnRequest` below) answers `return reply` and
 * stops, never a bare `return`.
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
 * The Fastify `onRequest` hook wiring `guardApiReady` into the whole `/_api` tree — registered as the
 * very first hook in `api/index.ts#routes`, before any route file is registered, so it covers
 * `sites.ts` (registered directly on that plugin) and every route under the guarded `contentApp`
 * encapsulation alike. `onRequest`, not `preHandler`: this needs no route param (unlike
 * `siteEnabledPreHandler`), and running as early as possible means a not-ready instance never spends
 * work on routing, body parsing or the permission/rate-limit hooks first.
 *
 * Async two-argument shape (no `done` callback), matching `core/http/authHooks.ts`'s own async
 * `onRequest` hooks (the API-key and rate-limit ones) rather than `siteEnabledPreHandler`'s
 * callback style, which exists only to signal a `preHandler` chain.
 */
export async function apiReadinessOnRequest(
  _req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  guardApiReady(reply)
}
