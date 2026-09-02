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
 * @returns `true` once the 304 has been sent, so the caller can `return` immediately after
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
