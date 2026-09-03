import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { isSameOriginWebSocketHandshake } from '../helpers/common.ts'
import terminalRoutes from '../controllers/terminal.ts'
import collabRoutes from '../controllers/collab.ts'
import { installTestWiki } from './mocks.ts'

/**
 * OpenProject #2120: the `verifyClient` cross-origin gate on the single `@fastify/websocket`
 * registration in `index.ts`.
 *
 * A WebSocket handshake is not subject to the same-origin policy and is not preflighted, so CORS
 * governs neither the handshake nor the frames that follow — unlike a form POST, the response is
 * fully readable by whichever origin opened the socket. `controllers/terminal.ts` and
 * `controllers/collab.ts` both authorize purely from `req.session`, which a foreign page's handshake
 * carries exactly as a same-origin one does, so the gate has to sit in front of both rather than in
 * either one.
 *
 * This suite reproduces `index.ts`'s actual registration shape — one `fastifyWebsocket` registration
 * feeding both controllers, exactly as `index.ts` wires them — rather than unit-testing
 * `isSameOriginWebSocketHandshake` in isolation (`helpers/common.test.ts` already does that
 * exhaustively). What this proves that a pure-function test cannot: that the real `ws` library
 * actually calls `verifyClient` before a route's own handler ever runs, for both routes, off the one
 * registration.
 *
 * No `WIKI` global beyond `WIKI.collab.capture`/`.refuse` (both called synchronously off the top of
 * `controllers/collab.ts`'s handler, before any other check) is needed: every assertion below is
 * settled by either the handshake being refused outright (`verifyClient`, before the handler runs at
 * all) or by each controller's own *first* check — `terminal.ts`'s `req.session?.authenticated`,
 * `collab.ts`'s `isValidUuid` (itself refused via `WIKI.collab.refuse`, not a bare `conn.close()`) —
 * neither of which touches a database or a model.
 */
describe('WebSocket verifyClient (OpenProject #2120)', () => {
  let app: FastifyInstance
  let wikiHandle: { restore(): void }

  /**
   * `app.injectWS()`'s synthetic upgrade request (`@fastify/websocket/index.js`) carries no `socket`
   * property at all. That's invisible for every OTHER route in this codebase's test suites, but `ws`'s
   * own `verifyClient` wiring (`node_modules/ws/lib/websocket-server.js`) unconditionally reads
   * `req.socket.authorized`/`req.socket.encrypted` to build `info.secure` — which throws
   * `TypeError: Cannot read properties of undefined (reading 'authorized')` the instant a
   * `verifyClient` is registered at all, real HTTP request or not. A real upgrade always has a socket,
   * so this only ever bites a test harness built on `injectWS`. `upgradeContext` is spread onto the
   * fake request before its fixed properties, so supplying `socket` here is enough to satisfy it.
   */
  const NON_TLS_SOCKET = { authorized: false, encrypted: false } as any

  before(async () => {
    wikiHandle = installTestWiki({
      collab: {
        // -> Called before `controllers/collab.ts` checks anything else; a no-op session object is
        //    all the paths this suite exercises ever touch.
        capture: () => ({}),
        // -> Every refusal branch in controllers/collab.ts -- including the very first, the
        //    isValidUuid check the "same-origin handshake reaches the controller" case below relies
        //    on -- calls WIKI.collab.refuse(conn, code, reason) instead of conn.close() directly (see
        //    that method's own doc comment on core/collab.ts). Without a stub here, that call throws
        //    "WIKI.collab.refuse is not a function" inside the handler, which @fastify/websocket does
        //    not turn into a close frame -- the socket is left open, and this suite's own
        //    `ws.once('close', ...)` wait (no timeout) then hangs forever. Mirrors the real
        //    implementation closely enough for this suite's purposes: a plain close, no grace-period
        //    terminate timer, since nothing here exercises a client that ignores the close frame.
        refuse: (
          conn: { close: (code: number, reason: string) => void },
          code: number,
          reason: string
        ) => conn.close(code, reason)
      }
    })

    app = fastify()

    // -> Mirrors `index.ts` exactly: one `fastifyWebsocket` registration, whose `verifyClient` both
    //    `/_terminal/logs` and `/_collab/:siteId/:pageId` inherit by being registered underneath it.
    await app.register(fastifyWebsocket, {
      options: {
        maxPayload: 5242880,
        verifyClient: (info: {
          origin: string
          secure: boolean
          req: import('node:http').IncomingMessage
        }) =>
          isSameOriginWebSocketHandshake(info.origin, info.req.headers.host, [
            'wiki.example.com',
            'second-site.example.com'
          ])
      }
    })
    await app.register(terminalRoutes, { prefix: '/_terminal' })
    await app.register(collabRoutes, { prefix: '/_collab' })
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  for (const [name, path] of [
    ['/_terminal/logs', '/_terminal/logs'],
    ['/_collab/:siteId/:pageId', '/_collab/not-a-uuid/not-a-uuid']
  ] as const) {
    describe(name, () => {
      test('a foreign Origin is rejected before the controller handler runs', async () => {
        /*
          `verifyClient` returning false makes `ws`'s own `Server.handleUpgrade()` write this 401
          directly onto the raw socket and never invoke its callback
          (node_modules/ws/lib/websocket-server.js) — the callback is what `@fastify/websocket`
          resolves into a call to the route's `wsHandler` (this controller's own function). A rejected
          handshake therefore proves the controller handler never started, not merely that the socket
          ended up closed: `terminal.ts` and `collab.ts` both close over an *open* WebSocket connection
          (close codes 4400/4401/4403/4404, never an HTTP status), so an HTTP-level 401 is a shape
          neither controller can produce on its own — it is only reachable by never reaching them.
        */
        await assert.rejects(
          () =>
            app.injectWS(path, {
              headers: { origin: 'https://evil.example.com', host: 'wiki.example.com' },
              socket: NON_TLS_SOCKET
            }),
          /Unexpected server response: 401/
        )
      })

      test('a same-origin handshake reaches the controller', async () => {
        const ws = await app.injectWS(path, {
          headers: { origin: 'https://wiki.example.com', host: 'wiki.example.com' },
          socket: NON_TLS_SOCKET
        })
        try {
          // -> Proven by each controller's own first check actually running and closing the socket
          //    for a reason that has nothing to do with origin — `terminal.ts`'s
          //    `req.session?.authenticated` (no session plugin is registered in this suite, so it is
          //    always falsy) for the terminal route, `collab.ts`'s `isValidUuid` for the collab route.
          const [code] = await new Promise<[number, Buffer]>((resolve) => {
            ws.once('close', (code: number, reason: Buffer) => resolve([code, reason]))
          })
          assert.ok(
            code === 4401 || code === 4400,
            `expected a controller-issued close code (4401 or 4400), got ${code}`
          )
        } finally {
          ws.terminate()
        }
      })

      test('a handshake whose Origin is another site on this same instance is also accepted', async () => {
        // -> `second-site.example.com` is neither `evil.example.com` (rejected above) nor the `host`
        //    header itself — it is only accepted because it is one of `WIKI.sitesMappings`' own
        //    hostnames, the "optionally also allowing a hostname in `WIKI.sitesMappings`" clause.
        const ws = await app.injectWS(path, {
          headers: { origin: 'https://second-site.example.com', host: 'wiki.example.com' },
          socket: NON_TLS_SOCKET
        })
        ws.terminate()
      })
    })
  }
})
