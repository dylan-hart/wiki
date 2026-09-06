import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, describe, test } from 'node:test'
import fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import type { FastifyInstance } from 'fastify'

import terminalRoutes from './terminal.ts'
import type { LogFrame } from '../core/logger.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * OpenProject #2648: the admin terminal used to identify the reader by e-mail address
 * (`req.session.user?.email ?? req.session.user?.id ?? 'unknown'`), which put that address on stdout,
 * into the backlog, and therefore in front of every admin who opens a terminal afterwards. The route
 * now names the user id and nothing else, matching how the rest of the codebase identifies an actor.
 *
 * OpenProject #2679: what goes down the socket is a `LogFrame` as JSON, not a rendered line, so this
 * suite reads the wire as data — first frame the `{ instance }` handshake, everything after it a
 * frame with `level` and `scope` of its own.
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
const INSTANCE_ID = 'inst-terminal-test'

/**
 * Everything the route reads off the logger, plus the frames it wrote, for assertions.
 *
 * The frames are built the way `core/logger.ts` builds them, which is what makes `backlog()` here a
 * stand-in for the real one rather than a differently-shaped fake.
 */
function createRecordingLogger() {
  const frames: LogFrame[] = []
  return {
    frames,
    logger: {
      error: () => {},
      warn: () => {},
      info: (scope: unknown, message: unknown, fields?: Record<string, unknown>) => {
        frames.push({
          timestamp: new Date().toISOString(),
          instance: INSTANCE_ID,
          level: 'info',
          scope: scope as LogFrame['scope'],
          message: String(message),
          fields: fields ?? {}
        })
      },
      debug: () => {},
      ws: new EventEmitter(),
      backlog: () => [...frames]
    }
  }
}

interface Harness {
  app: FastifyInstance
  frames: LogFrame[]
  restore(): void
}

/**
 * @param session The session every request is seeded with — `undefined` leaves it anonymous, which is
 *   how the refusal branches are reached.
 */
async function buildHarness(session?: Record<string, any>): Promise<Harness> {
  const { frames, logger } = createRecordingLogger()
  const wikiHandle = installTestWiki({ logger, INSTANCE_ID })

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
    frames,
    restore() {
      wikiHandle.restore()
    }
  }
}

/** Resolve once a frame matching `predicate` has been logged, or reject when it never arrives. */
async function waitForFrame(
  frames: LogFrame[],
  predicate: (frame: LogFrame) => boolean,
  what: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = frames.find(predicate)
    if (found) {
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`no ${what} record was logged; got: ${JSON.stringify(frames)}`)
}

/**
 * Every frame the socket delivers, in order, recorded from the moment the client exists.
 *
 * `injectWS`'s `onInit` hook is what makes that possible: the route writes its handshake and replays
 * its backlog synchronously inside the connection handler, so a listener attached after `injectWS`
 * has resolved misses both — `ws` is an `EventEmitter`, and an event with no listener is simply
 * gone. `onInit` runs before the socket is even opened.
 */
function recordFrames() {
  const received: string[] = []
  return {
    received,
    onInit: (ws: any) => {
      ws.on('message', (data: unknown) => received.push(String(data)))
    },
    /** Resolve once at least `n` frames have arrived, or reject rather than hang. */
    async atLeast(n: number): Promise<string[]> {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (received.length >= n) {
          return received
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`only ${received.length} of ${n} frames arrived: ${received}`)
    }
  }
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
      const attached = await waitForFrame(
        harness.frames,
        (frame) => frame.message === 'attached',
        'attach'
      )
      assert.equal(attached.scope, 'terminal')
      assert.deepEqual(attached.fields, { user: USER_ID })
    } finally {
      ws.terminate()
    }

    const detached = await waitForFrame(
      harness.frames,
      (frame) => frame.message === 'detached',
      'detach'
    )
    assert.equal(detached.scope, 'terminal')
    assert.deepEqual(detached.fields, { user: USER_ID })

    /*
      The whole point of the fix: nothing this route writes may carry the address, since every record
      here lands in the backlog that is replayed to the NEXT admin terminal to connect.
    */
    for (const frame of harness.frames) {
      const serialized = JSON.stringify(frame)
      assert.ok(
        !serialized.includes(USER_EMAIL),
        `log record leaked the e-mail address: ${serialized}`
      )
      assert.ok(
        !serialized.includes('@'),
        `log record looks like it carries an address: ${serialized}`
      )
    }
  })

  test('sends the handshake first, then structured frames (OpenProject #2679)', async () => {
    harness = await buildHarness({
      authenticated: true,
      permissions: ['manage:system'],
      user: { id: USER_ID, email: USER_EMAIL, name: 'Dana Admin' }
    })

    const frames = recordFrames()
    const ws = await harness.app.injectWS('/_terminal/logs', {}, { onInit: frames.onInit })
    try {
      /*
        Two frames are guaranteed on connect: the handshake, then the route's own `attached` record,
        which is written BEFORE the backlog is replayed and is therefore the first thing in it.
      */
      const [handshake, first] = await frames.atLeast(2)

      // -> Unchanged shape, and still the only frame that is not a log record
      assert.deepEqual(JSON.parse(handshake!), { instance: INSTANCE_ID })

      const frame = JSON.parse(first!) as LogFrame
      assert.equal(frame.level, 'info')
      assert.equal(frame.scope, 'terminal')
      assert.equal(frame.message, 'attached')
      assert.deepEqual(frame.fields, { user: USER_ID })
      assert.equal(frame.instance, INSTANCE_ID)
      assert.match(frame.timestamp, /^\d{4}-\d{2}-\d{2}T/)
    } finally {
      ws.terminate()
    }
  })

  test('a live record reaches an already-attached client as its own frame', async () => {
    harness = await buildHarness({
      authenticated: true,
      permissions: ['manage:system'],
      user: { id: USER_ID, email: USER_EMAIL, name: 'Dana Admin' }
    })

    const frames = recordFrames()
    const ws = await harness.app.injectWS('/_terminal/logs', {}, { onInit: frames.onInit })
    try {
      await frames.atLeast(2)

      const live: LogFrame = {
        timestamp: '2026-09-06T07:00:00.000Z',
        instance: INSTANCE_ID,
        level: 'error',
        scope: 'jobs',
        message: 'purgeUploads failed',
        fields: { job: 'job-1', error: { name: 'Error', message: 'disk full' } },
        stack: 'Error: disk full\n    at nowhere'
      }
      WIKI.logger.ws.emit('log', live)

      const [, , third] = await frames.atLeast(3)
      assert.deepEqual(JSON.parse(third!), live)
    } finally {
      ws.terminate()
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
    assert.deepEqual(harness.frames, [])
  })
})
