import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Attach a response's cache validators, and answer `304 Not Modified` outright when the client
 * already holds exactly these bytes.
 *
 * Six routes hand-rolled the identical three lines plus the `if-none-match` comparison
 * (`controllers/{site,files,thumb,blocks,user}.ts`, `api/locales.ts`, and `controllers/icons.ts`'s
 * own `sendCacheable` wrapper). The point of one function is that the headers cannot drift apart
 * from the comparison: a route that sets an `ETag` and then compares against a differently-built
 * string revalidates forever, and one that answers 304 without having sent the validators tells the
 * client nothing to revalidate with next time.
 *
 * `X-Content-Type-Options: nosniff` rides along by default because every one of those controllers is
 * serving bytes somebody uploaded — an avatar, a logo, a file, a custom block's code — and the
 * browser must take the declared type at its word rather than looking for something more interesting
 * in them. `nosniff: false` is for the callers that never sent it (`api/locales.ts`'s own strings,
 * `controllers/icons.ts`'s batch JSON), which is a difference in what they serve, not an oversight.
 *
 * **A caller answers `true` with `return reply`, never a bare `return`** (OpenProject #2644). Fastify's
 * `reply.sent` is `raw.writableEnded`, so while any async `onSend` hook is still awaiting it reads
 * `false` — and `@fastify/session`'s hook, registered on the root app in `core/http/session.ts`,
 * awaits a session-store round trip on every reply. An `async` handler resolving with `undefined` at
 * that moment makes `fastify/lib/wrap-thenable.js` take its `reply.sent === false &&
 * reply.raw.headersSent === false` branch and send the reply a SECOND time; the second write throws
 * `ERR_HTTP_HEADERS_SENT` and logs `Reply was already sent, did you forget to "return reply" …`.
 * Six of the seven callers wrote the bare `return` this comment used to ask for, and the locale
 * strings route — revalidated by the SPA on every page load — was doing it on every cached fetch.
 * The 304 `response` schema is not involved: the async hook alone is enough, verified directly
 * against `fastify@5.12.1`. `api/locales.test.ts` holds the regression test, and
 * `httpCache.test.ts` scans every call site for the `return reply`.
 *
 * @returns `true` once the 304 has been sent, so the caller can `return reply` immediately after
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
