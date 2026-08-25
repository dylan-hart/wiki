import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import WebSocket from 'ws'
import { websocketVerifyClient } from './helpers/security.ts'
import terminalRoutes from './controllers/terminal.ts'
import collabRoutes from './controllers/collab.ts'

/**
 * Round trip for task 2120 / WP 2105 §5 spanning three files with no single co-located home: the
 * `verifyClient` callback (`helpers/security.ts`, already unit-tested there in isolation) wired onto
 * the single real `fastifyWebsocket` registration `index.ts` makes, fronting the two real websocket
 * controllers (`controllers/terminal.ts`, `controllers/collab.ts`) exactly as `index.ts` registers
 * them. `helpers/security.test.ts` already proves `isSameOriginHeader`'s same-origin/cross-origin
 * decision in isolation; what THIS file proves is the thing a pure function test cannot: that the
 * decision actually gates the handshake before either controller's own `req.session` check runs, and
 * that both routes are covered by the one registration.
 *
 * The tell: a `verifyClient` rejection fails the HTTP Upgrade itself (the `ws` client never opens a
 * WebSocket connection at all -- no `open`, no `close`, no session-derived close code, just an HTTP
 * error response on the handshake). A request `verifyClient` allows through, but that a controller
 * then refuses for lacking `req.session.authenticated`, closes a REAL websocket connection with the
 * controller's own private-range code (4401) -- proof the controller's own code actually ran. No real
 * session/login is set up here on purpose: reaching that controller-level 4401 (rather than an
 * `verifyClient`-level HTTP rejection) is itself the proof the origin gate let the handshake through.
 */

// -> `isValidUuid` (helpers/common.ts) checks the version/variant nibbles, not just the shape --
//    these have to actually pass it to reach the session check `controllers/collab.ts` makes past
//    its own uuid guard.
const VALID_SITE_ID = '11111111-1111-4111-8111-111111111111'
const VALID_PAGE_ID = '22222222-2222-4222-8222-222222222222'

let app: FastifyInstance
let baseUrl: string

before(async () => {
  ;(globalThis as any).WIKI = {
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
    INSTANCE_ID: 'test-instance',
    collab: { capture: () => ({}) }
  }

  app = fastify()
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 5242880, verifyClient: websocketVerifyClient }
  })
  await app.register(terminalRoutes, { prefix: '/_terminal' })
  await app.register(collabRoutes, { prefix: '/_collab' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `ws://127.0.0.1:${port}`
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

/**
 * Attempts one handshake and reports which of the two distinguishable outcomes happened: an
 * `unexpected-response` (the HTTP Upgrade itself was refused -- `verifyClient` never let a websocket
 * connection open at all) or a real `close` (a websocket connection opened, meaning `verifyClient`
 * allowed it through, and closed with whatever code the controller itself decided).
 */
function attemptHandshake(
  path: string,
  headers: Record<string, string>
): Promise<{ kind: 'rejected'; statusCode: number } | { kind: 'closed'; code: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}${path}`, { headers })
    ws.on('unexpected-response', (_req, res) => {
      resolve({ kind: 'rejected', statusCode: res.statusCode! })
      ws.terminate()
    })
    ws.on('open', () => {
      // -> The handshake succeeded (verifyClient let it through); wait for the controller's own
      //    close, which is what proves the controller actually ran.
    })
    ws.on('close', (code) => {
      resolve({ kind: 'closed', code })
    })
    ws.on('error', (err) => {
      // -> A raw ECONNRESET etc. would land here rather than 'unexpected-response' on some
      //    platforms; only reject if neither of the above already resolved this promise.
      reject(err)
    })
  })
}

test('a foreign Origin is rejected at the handshake, before /_terminal/logs ever runs', async () => {
  const result = await attemptHandshake('/_terminal/logs', {
    Origin: 'https://evil.example.com'
  })
  assert.equal(result.kind, 'rejected')
  assert.equal((result as any).statusCode, 403)
})

test('a foreign Origin is rejected at the handshake, before /_collab/:siteId/:pageId ever runs', async () => {
  const result = await attemptHandshake(`/_collab/${VALID_SITE_ID}/${VALID_PAGE_ID}`, {
    Origin: 'https://evil.example.com'
  })
  assert.equal(result.kind, 'rejected')
  assert.equal((result as any).statusCode, 403)
})

test('a same-origin handshake reaches /_terminal/logs, which then refuses for lacking a session', async () => {
  // -> No explicit `Host` override: connecting straight to `127.0.0.1:<port>` already makes that
  //    the natural `Host` header, so `Origin` only needs to name the same thing.
  const result = await attemptHandshake('/_terminal/logs', {
    Origin: baseUrl.replace('ws://', 'http://')
  })
  // -> A real websocket connection opened and was closed BY THE CONTROLLER (4401 is
  //    controllers/terminal.ts's own "Authentication is required" code) -- proof verifyClient let
  //    it through and the controller's own code ran.
  assert.equal(result.kind, 'closed')
  assert.equal((result as any).code, 4401)
})

test('a same-origin handshake reaches /_collab/:siteId/:pageId, which then refuses for lacking a session', async () => {
  const result = await attemptHandshake(`/_collab/${VALID_SITE_ID}/${VALID_PAGE_ID}`, {
    Origin: baseUrl.replace('ws://', 'http://')
  })
  assert.equal(result.kind, 'closed')
  assert.equal((result as any).code, 4401)
})
