import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, describe, test } from 'node:test'
import fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import type { FastifyInstance } from 'fastify'

import terminalRoutes from './terminal.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * OpenProject #2648: the admin terminal used to identify the reader by e-mail address
 * (`req.session.user?.email ?? req.session.user?.id ?? 'unknown'`), which put that address on stdout,
 * into the 100-line backlog, and therefore in front of every admin who opens a terminal afterwards.
 * The route now names the user id and nothing else, matching how the rest of the codebase identifies
 * an actor.
 *
 * The suite drives the REAL controller over a real `@fastify/websocket` upgrade (`app.injectWS`),
 * rather than calling the handler with a fake socket: the disconnect line is written from the
 * socket's own `close` listener, and only an actual close frame reaches it. The origin gate is
 * deliberately absent here — `test/websocketOrigin.test.ts` owns that, and registering a
 * `verifyClient` under `injectWS` needs a synthetic `socket` on every request for no gain to what
 * this file asserts.
 */

const USER_ID = 'f0a4a3d6-2c1f-4f66-8a52-9e33ba0f1c77'
const USER_EMAIL = 'dana.admin@example.com'

/** Everything the route reads off the logger, plus the lines it wrote, for assertions. */
function createRecordingLogger() {
  const lines: string[] = []
  return {
    lines,
    logger: {
      error: () => {},
      warn: () => {},
      info: (msg: unknown) => {
        lines.push(String(msg))
      },
      debug: () => {},
      verbose: () => {},
      silly: () => {},
      ws: new EventEmitter(),
      backlog: () => [...lines]
    }
  }
}

interface Harness {
  app: FastifyInstance
  lines: string[]
  restore(): void
}

/**
 * @param session The session every request is seeded with — `undefined` leaves it anonymous, which is
 *   how the refusal branches are reached.
 */
async function buildHarness(session?: Record<string, any>): Promise<Harness> {
  const { lines, logger } = createRecordingLogger()
  const wikiHandle = installTestWiki({ logger })

  const app = fastify()
  await app.register(fastifyWebsocket)
  /*
    Seeds `req.session` the way `@fastify/session` would on a real request. Registered before the
    routes so the hook is in place for the upgrade request itself — a `websocket: true` route runs the
    same onRequest chain as any other.
  */
  app.addHook('onRequest', async (req) => {
    ;(req as any).session = session
  })
  await app.register(terminalRoutes, { prefix: '/_terminal' })
  await app.ready()

  return {
    app,
    lines,
    restore() {
      wikiHandle.restore()
    }
  }
}

/** Resolve once a line matching `predicate` has been logged, or reject when it never arrives. */
async function waitForLine(lines: string[], predicate: (line: string) => boolean, what: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = lines.find(predicate)
    if (found) {
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`no ${what} line was logged; got: ${JSON.stringify(lines)}`)
}

describe('GET /_terminal/logs — who is reading the logs (OpenProject #2648)', () => {
  let harness: Harness | null = null

  afterEach(async () => {
    if (harness) {
      await harness.app.close()
      harness.restore()
      harness = null
    }
  })

  test('names the reader by id, never by e-mail address, on attach and detach', async () => {
    harness = await buildHarness({
      authenticated: true,
      permissions: ['manage:system'],
      user: { id: USER_ID, email: USER_EMAIL, name: 'Dana Admin' }
    })

    const ws = await harness.app.injectWS('/_terminal/logs')
    try {
      const attached = await waitForLine(
        harness.lines,
        (line) => line.includes('[ CONNECTED ]'),
        'attach'
      )
      assert.match(attached, new RegExp(`user=${USER_ID}`))
    } finally {
      ws.terminate()
    }

    const detached = await waitForLine(
      harness.lines,
      (line) => line.includes('[ DISCONNECTED ]'),
      'detach'
    )
    assert.match(detached, new RegExp(`user=${USER_ID}`))

    /*
      The whole point of the fix: nothing this route writes may carry the address, since every line
      here lands in the backlog that is replayed to the NEXT admin terminal to connect.
    */
    for (const line of harness.lines) {
      assert.ok(!line.includes(USER_EMAIL), `log line leaked the e-mail address: ${line}`)
      assert.ok(!line.includes('@'), `log line looks like it carries an address: ${line}`)
    }
  })

  test('logs nothing at all for a caller it refuses', async () => {
    harness = await buildHarness({
      authenticated: true,
      permissions: ['manage:sites'],
      user: { id: USER_ID, email: USER_EMAIL, name: 'Dana Admin' }
    })

    const ws = await harness.app.injectWS('/_terminal/logs')
    const [code] = await new Promise<[number]>((resolve) => {
      ws.once('close', (closeCode: number) => resolve([closeCode]))
    })

    ws.terminate()

    assert.equal(code, 4403)
    assert.deepEqual(harness.lines, [])
  })
})
