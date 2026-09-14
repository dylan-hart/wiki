import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, mock, test } from 'node:test'
import fastify from 'fastify'
import {
  createGracefulShutdown,
  PRE_CLOSE_DELAY_MS,
  registerProbes,
  runShutdownSequence,
  SHUTDOWN,
  SHUTTING_DOWN
} from './shutdown.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('registerProbes', () => {
  test('/_live answers 200 regardless of readiness', async () => {
    const app = fastify()
    registerProbes(app, () => false)
    await app.ready()
    try {
      const res = await app.inject({ method: 'GET', url: '/_live' })
      assert.equal(res.statusCode, 200)
    } finally {
      await app.close()
    }
  })

  test('/_ready answers 200 once isReady() is true', async () => {
    const app = fastify()
    let ready = false
    registerProbes(app, () => ready)
    await app.ready()
    try {
      const before = await app.inject({ method: 'GET', url: '/_ready' })
      assert.equal(before.statusCode, 503)
      assert.deepEqual(before.json(), { status: 'not ready' })

      ready = true
      const after = await app.inject({ method: 'GET', url: '/_ready' })
      assert.equal(after.statusCode, 200)
      assert.deepEqual(after.json(), { status: 'ok' })
    } finally {
      await app.close()
    }
  })
})

/**
 * The core acceptance criterion (OpenProject #3156): "Probe behaviour is covered by tests: ready →
 * shutting down → closed." Drives `registerProbes` and `runShutdownSequence` together against one
 * real Fastify app — the same wiring `createGracefulShutdown` does in production, minus
 * `close-with-grace`'s real process-signal handlers and its own `process.exit()` call (which would
 * kill the test runner — see `createGracefulShutdown`'s own describe below for why that half is
 * tested differently).
 */
describe('runShutdownSequence: ready → shutting down → closed', () => {
  test('flips /_ready to 503 the instant teardown starts, well before it finishes', async () => {
    const app = fastify()
    let ready = false
    let shuttingDown = false
    registerProbes(app, () => ready && !shuttingDown)
    await app.ready()

    try {
      // -> ready
      assert.equal((await app.inject({ method: 'GET', url: '/_ready' })).statusCode, 503)
      ready = true
      assert.equal((await app.inject({ method: 'GET', url: '/_ready' })).statusCode, 200)

      // -> shutting down: the sequence's own app.close() would end the app this test still wants to
      //    inject against, so a no-op stand-in for `app.close` is passed instead of the real app.
      const emitter = new EventEmitter()
      const shutdownPromise = runShutdownSequence(
        { signal: 'SIGTERM' },
        { close: async () => {} },
        [],
        emitter,
        () => {
          shuttingDown = true
        },
        { preCloseDelayMs: 20 }
      )

      // -> Set synchronously, before the pre-close delay even starts — so a probe polled at any
      //    point from here on reports not-ready, not just once the whole teardown has finished.
      assert.equal((await app.inject({ method: 'GET', url: '/_ready' })).statusCode, 503)

      await shutdownPromise
      assert.equal((await app.inject({ method: 'GET', url: '/_ready' })).statusCode, 503)
    } finally {
      await app.close()
    }
  })

  test('closed: runs the pre-close delay, then the close tasks, then app.close(), in that order', async () => {
    const order: string[] = []
    const app = {
      close: async () => {
        order.push('app.close')
      }
    }
    const closeTasks = [
      async () => {
        order.push('task-1')
      },
      async () => {
        order.push('task-2')
      }
    ]
    const emitter = new EventEmitter()
    const onShuttingDown = mock.fn()

    await runShutdownSequence({ signal: 'SIGTERM' }, app, closeTasks, emitter, onShuttingDown, {
      preCloseDelayMs: 5
    })

    assert.equal(onShuttingDown.mock.callCount(), 1)
    assert.deepEqual(order, ['task-1', 'task-2', 'app.close'])
  })

  test('a rejecting close task does not stop the others or app.close() (Promise.allSettled)', async () => {
    const order: string[] = []
    const app = {
      close: async () => {
        order.push('app.close')
      }
    }
    const closeTasks = [
      async () => {
        throw new Error('scheduler drain failed')
      },
      async () => {
        order.push('task-2')
      }
    ]

    await assert.doesNotReject(
      runShutdownSequence({ signal: 'SIGTERM' }, app, closeTasks, new EventEmitter(), () => {}, {
        preCloseDelayMs: 0
      })
    )
    assert.deepEqual(order, ['task-2', 'app.close'])
  })

  test('emits SHUTTING_DOWN with an Error(signal) for a signal-triggered shutdown', async () => {
    const emitter = new EventEmitter()
    const shuttingDown = mock.fn()
    emitter.on(SHUTTING_DOWN, shuttingDown)

    await runShutdownSequence(
      { signal: 'SIGTERM' },
      { close: async () => {} },
      [],
      emitter,
      () => {},
      { preCloseDelayMs: 0 }
    )

    assert.equal(shuttingDown.mock.callCount(), 1)
    const [err] = shuttingDown.mock.calls[0].arguments as [Error]
    assert.ok(err instanceof Error)
    assert.equal(err.message, 'SIGTERM')
  })

  test('emits SHUTTING_DOWN with the real Error for an uncaughtException-triggered shutdown', async () => {
    const emitter = new EventEmitter()
    const shuttingDown = mock.fn()
    emitter.on(SHUTTING_DOWN, shuttingDown)
    const boom = new Error('boom')

    await runShutdownSequence({ err: boom }, { close: async () => {} }, [], emitter, () => {}, {
      preCloseDelayMs: 0
    })

    assert.equal(shuttingDown.mock.calls[0].arguments[0], boom)
  })

  test('emits SHUTTING_DOWN with no reason at all for a programmatic close', async () => {
    const emitter = new EventEmitter()
    const shuttingDown = mock.fn()
    emitter.on(SHUTTING_DOWN, shuttingDown)

    await runShutdownSequence({}, { close: async () => {} }, [], emitter, () => {}, {
      preCloseDelayMs: 0
    })

    assert.equal(shuttingDown.mock.calls[0].arguments[0], undefined)
  })

  test('emits SHUTDOWN only once app.close() has resolved', async () => {
    const emitter = new EventEmitter()
    const events: string[] = []
    emitter.on(SHUTTING_DOWN, () => events.push(SHUTTING_DOWN))
    emitter.on(SHUTDOWN, () => events.push(SHUTDOWN))

    await runShutdownSequence(
      { signal: 'SIGTERM' },
      { close: async () => events.push('app.close') },
      [],
      emitter,
      () => {},
      { preCloseDelayMs: 0 }
    )

    assert.deepEqual(events, [SHUTTING_DOWN, 'app.close', SHUTDOWN])
  })

  test('defaults to the 5s pre-close delay when none is given', () => {
    assert.equal(PRE_CLOSE_DELAY_MS, 5000)
  })
})

/**
 * "A SIGTERM during an in-flight request lets it finish within the delay" (OpenProject #3156): the
 * pre-close delay runs entirely BEFORE `app.close()` is ever called, so a request already being
 * served — or one that arrives during the delay — has the whole window to complete on a real,
 * still-open Fastify app, not a stand-in.
 */
describe('runShutdownSequence: an in-flight request survives the pre-close delay', () => {
  test('a slow request started during the delay completes before app.close() runs', async () => {
    const app = fastify()
    app.get('/slow', async () => {
      await sleep(20)
      return { ok: true }
    })
    await app.ready()

    const closeCalledAt: number[] = []
    const appProxy = {
      close: async () => {
        closeCalledAt.push(Date.now())
        await app.close()
      }
    }

    const start = Date.now()
    const shutdownPromise = runShutdownSequence(
      { signal: 'SIGTERM' },
      appProxy,
      [],
      new EventEmitter(),
      () => {},
      { preCloseDelayMs: 60 }
    )

    // -> Started once teardown has already begun (shuttingDown flips synchronously, at the top of
    //    the sequence), the same window a request already in flight at the moment SIGTERM arrived
    //    would be in.
    const res = await app.inject({ method: 'GET', url: '/slow' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true })

    // -> The request resolved well inside the 60ms pre-close delay, and close() had not run yet —
    //    proving it wasn't the request racing a socket teardown that happened to still work, but
    //    the delay genuinely holding `app.close()` off until after this can complete.
    assert.equal(closeCalledAt.length, 0, 'app.close() must not run before the request resolved')

    await shutdownPromise
    assert.equal(closeCalledAt.length, 1)
    assert.ok(
      closeCalledAt[0] - start >= 55,
      `expected app.close() to run only after the ~60ms delay, was called after ${closeCalledAt[0] - start}ms`
    )
  })
})

/**
 * `createGracefulShutdown` wires the sequence above up to real `close-with-grace`, which installs
 * real listeners on the real `process` and — once its callback resolves — calls `process.exit()`
 * itself. These tests never let that callback fire (which would kill the test runner): they assert
 * only on what gets INSTALLED, immediately `uninstall()`-ing it again.
 */
describe('createGracefulShutdown: process wiring', () => {
  test('installs listeners for the contracted signal set (SIGINT, SIGTERM, SIGHUP) and uncaughtException', () => {
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGHUP: process.listenerCount('SIGHUP'),
      uncaughtException: process.listenerCount('uncaughtException')
    }

    const controller = createGracefulShutdown({ close: async () => {} }, [])
    try {
      assert.equal(process.listenerCount('SIGINT'), before.SIGINT + 1)
      assert.equal(process.listenerCount('SIGTERM'), before.SIGTERM + 1)
      assert.equal(process.listenerCount('SIGHUP'), before.SIGHUP + 1)
      assert.equal(process.listenerCount('uncaughtException'), before.uncaughtException + 1)
    } finally {
      controller.uninstall()
    }

    assert.equal(process.listenerCount('SIGINT'), before.SIGINT)
    assert.equal(process.listenerCount('SIGTERM'), before.SIGTERM)
    assert.equal(process.listenerCount('SIGHUP'), before.SIGHUP)
    assert.equal(process.listenerCount('uncaughtException'), before.uncaughtException)
  })

  test('installs no unhandledRejection listener — core/processGuards.ts stays the sole owner', () => {
    const before = process.listenerCount('unhandledRejection')

    const controller = createGracefulShutdown({ close: async () => {} }, [])
    try {
      assert.equal(
        process.listenerCount('unhandledRejection'),
        before,
        'createGracefulShutdown must not add a second unhandledRejection listener'
      )
    } finally {
      controller.uninstall()
    }
    assert.equal(process.listenerCount('unhandledRejection'), before)
  })

  test('installs no beforeExit or non-contracted signal (e.g. SIGQUIT) listener', () => {
    const before = {
      beforeExit: process.listenerCount('beforeExit'),
      SIGQUIT: process.listenerCount('SIGQUIT')
    }

    const controller = createGracefulShutdown({ close: async () => {} }, [])
    try {
      assert.equal(process.listenerCount('beforeExit'), before.beforeExit)
      assert.equal(process.listenerCount('SIGQUIT'), before.SIGQUIT)
    } finally {
      controller.uninstall()
    }
  })

  test('setReady()/isReady() track readiness with no signal involved', () => {
    const controller = createGracefulShutdown({ close: async () => {} }, [])
    try {
      assert.equal(controller.isReady(), false)
      controller.setReady()
      assert.equal(controller.isReady(), true)
    } finally {
      controller.uninstall()
    }
  })
})
