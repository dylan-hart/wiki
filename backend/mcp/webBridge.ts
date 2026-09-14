/**
 * Fastify ↔ Web Standard `Request`/`Response` bridge for the MCP HTTP transport.
 *
 * `@modelcontextprotocol/server`'s `WebStandardStreamableHTTPServerTransport` (v2 — OpenProject
 * #3160) speaks the Fetch API's `Request`/`Response`, not Fastify's Node-native `req.raw`/
 * `reply.raw` the v1 SDK's `StreamableHTTPServerTransport` used to write straight to. The obvious
 * adapter — `@modelcontextprotocol/node`'s `NodeStreamableHTTPServerTransport`, which keeps that
 * same `(req.raw, reply.raw, body)` shape — depends on `@hono/node-server` (a real `dependencies`
 * entry of that package, not a peer) purely to do this same conversion, which would drag `hono` back
 * into this project's tree — exactly what #3160 exists to remove (`npm ls express hono` must show
 * neither). See `docs/decisions/2026-09-14-mcp-v2-fastify-bridge.md` for the full reasoning,
 * including why `@modelcontextprotocol/fastify` itself isn't a dependency either.
 *
 * This file is the small, dependency-free substitute: convert one Fastify request into a Web
 * Standard `Request`, and stream a Web Standard `Response` back onto Fastify's hijacked raw reply.
 * `Request`/`Response`/`Headers` are Node's own (undici) globals since Node 18 — nothing new is
 * installed for this.
 */

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Build the Web Standard `Request` a `WebStandardStreamableHTTPServerTransport` expects, from a
 * Fastify request.
 *
 * Carries no body of its own: Fastify has already parsed a JSON POST body onto `req.body` (the app's
 * default JSON content-type parser — see `core/http/server.ts`), so every call site hands that back
 * through `handleRequest`'s own `options.parsedBody` instead of this constructing a second body
 * stream for the transport to re-read. A `GET`/`DELETE` has no body either way.
 *
 * The URL only needs to be well-formed, not proxy-accurate: nothing the transport reads off it
 * (session/protocol-version validation, method routing) depends on the scheme or host being exactly
 * what a client behind a reverse proxy saw.
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
 * Write a Web Standard `Response` onto a Fastify reply already taken over with `reply.hijack()`.
 *
 * Streams the body rather than buffering it — an SSE response's `body` keeps yielding chunks for as
 * long as the session's stream stays open, so this call's own returned promise stays pending for
 * that whole lifetime, same as the route handler that awaits it. `pipeline()` is what tears the
 * stream down correctly if the client disconnects first: destroying `res` (Fastify's raw
 * `ServerResponse`) propagates back through `Readable.fromWeb()` as a `cancel()` on the underlying
 * web `ReadableStream`, the same cleanup the transport's own reader relies on.
 */
export async function sendWebResponse(reply: FastifyReply, response: Response): Promise<void> {
  const res = reply.raw
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) {
    res.end()
    return
  }
  // -> `response.body`'s global `ReadableStream` (declared by `@types/node`'s DOM-shaped fetch types)
  //    and `node:stream/web`'s own `ReadableStream` `Readable.fromWeb()` expects are structurally the
  //    same object at runtime but diverge in their `ArrayBufferView` generics under `strict` — a real
  //    `@types/node` typing gap, not a runtime concern. Narrowed through the real `node:stream/web`
  //    type rather than `any`, so a genuine shape mismatch here would still fail to compile.
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
    res
  )
}
