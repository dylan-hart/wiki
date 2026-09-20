/**
 * Fastify ↔ Web Standard `Request`/`Response` bridge for the MCP HTTP transport.
 *
 * `WebStandardStreamableHTTPServerTransport` speaks the Fetch API, not the Node-native
 * `req.raw`/`reply.raw` Fastify hands out. The obvious adapter —
 * `@modelcontextprotocol/node`'s `NodeStreamableHTTPServerTransport` — depends on `@hono/node-server`
 * purely to do this same conversion, which would drag `hono` into the dependency tree;
 * `docs/decisions/2026-09-14-mcp-v2-fastify-bridge.md` carries the rest of the reasoning, including
 * why `@modelcontextprotocol/fastify` is not a dependency either. `Request`/`Response`/`Headers` are
 * Node's own undici globals, so this substitute installs nothing.
 */

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Carries no body: Fastify has already parsed a JSON POST body onto `req.body`, so every call site
 * hands that back through `handleRequest`'s own `options.parsedBody` rather than have this build a
 * second stream for the transport to re-read.
 *
 * The URL only needs to be well-formed, not proxy-accurate — nothing the transport reads off it
 * depends on the scheme or host a client behind a reverse proxy saw.
 */
export function toWebRequest(req: FastifyRequest): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue
    }
    for (const single of Array.isArray(value) ? value : [value]) {
      headers.append(key, single)
    }
  }
  return new Request(new URL(req.url, `${req.protocol}://${req.hostname}`), {
    method: req.method,
    headers
  })
}

/**
 * Writes onto a reply already taken over with `reply.hijack()`, streaming rather than buffering: an
 * SSE body keeps yielding for as long as the session's stream stays open, so this promise stays
 * pending that whole time, as does the route handler awaiting it. `pipeline()` is what tears the
 * stream down when the client disconnects first — destroying `res` propagates back through
 * `Readable.fromWeb()` as a `cancel()` on the underlying web `ReadableStream`.
 */
export async function sendWebResponse(reply: FastifyReply, response: Response): Promise<void> {
  const res = reply.raw
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) {
    res.end()
    return
  }
  // -> `response.body`'s global `ReadableStream` and the `node:stream/web` one `Readable.fromWeb()`
  //    expects are the same object at runtime but diverge in their `ArrayBufferView` generics under
  //    `strict` — an `@types/node` gap. Narrowed to the real type rather than `any`, so a genuine
  //    shape mismatch still fails to compile.
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
    res
  )
}
