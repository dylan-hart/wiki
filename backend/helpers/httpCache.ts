import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Attach a response's cache validators, and answer `304 Not Modified` outright when the client
 * already holds exactly these bytes; returns `true` once that 304 has been sent. One function so
 * the headers cannot drift apart from the comparison: an `ETag` compared against a differently-built
 * string revalidates forever, and a 304 without the validators leaves nothing to revalidate with.
 *
 * `nosniff` defaults on because most callers serve bytes somebody uploaded, and the browser must
 * take the declared type at its word. `nosniff: false` is for a caller serving the app's own content.
 *
 * **A caller answers `true` with `return reply`, never a bare `return`.** Fastify's `reply.sent`
 * reads `false` while any async `onSend` hook is still awaiting — and `@fastify/session`'s awaits a
 * session-store round trip on every reply. An `async` handler resolving with `undefined` at that
 * moment makes Fastify send the reply a SECOND time, which throws `ERR_HTTP_HEADERS_SENT` and logs
 * `Reply was already sent, did you forget to "return reply" …`. `httpCache.test.ts` scans every
 * call site for it.
 */
export function notModifiedOrPrepare(
  req: FastifyRequest,
  reply: FastifyReply,
  { etag, cacheControl, nosniff = true }: { etag: string; cacheControl: string; nosniff?: boolean }
): boolean {
  reply.header('ETag', etag)
  reply.header('Cache-Control', cacheControl)
  if (nosniff) {
    reply.header('X-Content-Type-Options', 'nosniff')
  }
  if (req.headers['if-none-match'] === etag) {
    reply.code(304).send()
    return true
  }
  return false
}
