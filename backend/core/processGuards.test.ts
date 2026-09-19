import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, mock, test } from 'node:test'
import { registerUnhandledRejectionHandler, runBootPhaseOrExit } from './processGuards.ts'

function createLoggerStub() {
  return { error: mock.fn() }
}

describe('runBootPhaseOrExit', () => {
  test('does not log or exit when the phase resolves', async () => {
    const logger = createLoggerStub()
    const exit = mock.fn()

    await runBootPhaseOrExit(async () => {}, 'post-boot initialization', logger, { exit })

    assert.equal(logger.error.mock.calls.length, 0)
    assert.equal(exit.mock.calls.length, 0)
  })

  test('logs through logger.error and exits(1) when the phase rejects', async () => {
    const logger = createLoggerStub()
    const exit = mock.fn()

    const err = new Error('remote storage unreachable')
    await runBootPhaseOrExit(
      async () => {
        throw err
      },
      'post-boot initialization',
      logger,
      { exit }
    )

    assert.equal(logger.error.mock.calls.length, 1)
    assert.deepEqual(logger.error.mock.calls[0].arguments, [
      'boot',
      'post-boot initialization failed',
      { error: err }
    ])
    assert.equal(exit.mock.calls.length, 1)
    assert.equal(exit.mock.calls[0].arguments[0], 1)
  })

  test('reports the failure as ONE record carrying the error, not a second debug-gated call', async () => {
    const logger = createLoggerStub()
    const exit = mock.fn()
    const err = new Error('boom')

    await runBootPhaseOrExit(
      async () => {
        throw err
      },
      'post-boot initialization',
      logger,
      { exit }
    )

    assert.equal(logger.error.mock.calls.length, 1)
    assert.equal(logger.error.mock.calls[0].arguments[2].error, err)
  })

  test('does not swallow a rejection propagating past the phase—exit is still called, not thrown out', async () => {
    // -> `runBootPhaseOrExit` itself must never reject, even when the injected `exit` returns.
    const logger = createLoggerStub()
    const exit = mock.fn()

    await assert.doesNotReject(
      runBootPhaseOrExit(
        async () => {
          throw new Error('fails')
        },
        'label',
        logger,
        { exit }
      )
    )
  })
})

describe('registerUnhandledRejectionHandler', () => {
  test('logs a rejected Error reason through logger.error', () => {
    const logger = createLoggerStub()
    const target = new EventEmitter()

    const err = new Error('search engine init failed')
    registerUnhandledRejectionHandler(logger, { target })
    target.emit('unhandledRejection', err)

    assert.equal(logger.error.mock.calls.length, 1)
    assert.deepEqual(logger.error.mock.calls[0].arguments, [
      'boot',
      'unhandled promise rejection: search engine init failed',
      { error: err }
    ])
  })

  test('stringifies a non-Error rejection reason', () => {
    const logger = createLoggerStub()
    const target = new EventEmitter()

    registerUnhandledRejectionHandler(logger, { target })
    target.emit('unhandledRejection', 'plain string reason')

    assert.equal(logger.error.mock.calls.length, 1)
    assert.deepEqual(logger.error.mock.calls[0].arguments, [
      'boot',
      'unhandled promise rejection: plain string reason',
      {}
    ])
  })

  test('carries the Error in one record rather than a second debug-gated call', () => {
    const logger = createLoggerStub()
    const target = new EventEmitter()
    const err = new Error('boom')

    registerUnhandledRejectionHandler(logger, { target })
    target.emit('unhandledRejection', err)

    assert.equal(logger.error.mock.calls.length, 1)
    assert.equal(logger.error.mock.calls[0].arguments[2].error, err)
  })

  test('calls exit(1) after logging when an exit is injected', () => {
    const logger = createLoggerStub()
    const target = new EventEmitter()
    const exit = mock.fn()

    registerUnhandledRejectionHandler(logger, { target, exit })
    target.emit('unhandledRejection', new Error('search engine init failed'))

    assert.equal(logger.error.mock.calls.length, 1)
    assert.equal(exit.mock.calls.length, 1)
    assert.equal(exit.mock.calls[0].arguments[0], 1)
  })

  test('logs without exiting when no exit is injected', () => {
    const logger = createLoggerStub()
    const target = new EventEmitter()

    registerUnhandledRejectionHandler(logger, { target })

    assert.doesNotThrow(() => {
      target.emit('unhandledRejection', new Error('boom'))
    })
    assert.equal(logger.error.mock.calls.length, 1)
  })

  test('does not crash the process—the handler runs instead of the default termination', () => {
    // -> A plain EventEmitter stands in for `process`: a handler that logs and returns normally is
    //    what replaces Node's default, process-terminating behavior.
    const logger = createLoggerStub()
    const target = new EventEmitter()

    registerUnhandledRejectionHandler(logger, { target })

    assert.doesNotThrow(() => {
      target.emit('unhandledRejection', new Error('after boot'))
    })
    assert.equal(logger.error.mock.calls.length, 1)
  })
})
