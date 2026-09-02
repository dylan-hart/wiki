import assert from 'node:assert/strict'
import { afterEach, describe, mock, test } from 'node:test'
import logger from './logger.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * Pure unit test: `logger.ts` reads only `WIKI.config.{logFormat,logLevel}` and `WIKI.INSTANCE_ID`,
 * so a minimal stand-in global is enough — no database, no other model.
 */
function setWiki(config: { logFormat: string; logLevel: string }) {
  installTestWiki({
    config,
    INSTANCE_ID: 'test-instance'
  })
}

describe('logger', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  test('json format serializes an Error with its stack, not {}', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.error(new Error('boom'))

    assert.equal(logSpy.mock.calls.length, 1)
    const line = logSpy.mock.calls[0]!.arguments[0] as string
    const parsed = JSON.parse(line)
    assert.equal(parsed.level, 'error')
    assert.equal(typeof parsed.message, 'string')
    assert.notEqual(parsed.message, '{}')
    assert.match(parsed.message, /Error: boom/)
  })

  test('text format still renders an Error as its stack', () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.warn(new Error('kaboom'))

    assert.equal(logSpy.mock.calls.length, 1)
    const line = logSpy.mock.calls[0]!.arguments[0] as string
    assert.match(line, /Error: kaboom/)
  })

  test('json format leaves a plain string message untouched', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('hello world')

    const line = logSpy.mock.calls[0]!.arguments[0] as string
    const parsed = JSON.parse(line)
    assert.equal(parsed.message, 'hello world')
  })

  test('json format merges a context object as siblings of message', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('request handled', { requestId: 'abc-123', durationMs: 42 })

    const line = logSpy.mock.calls[0]!.arguments[0] as string
    const parsed = JSON.parse(line)
    assert.equal(parsed.message, 'request handled')
    assert.equal(parsed.requestId, 'abc-123')
    assert.equal(parsed.durationMs, 42)
    assert.deepEqual(Object.keys(parsed).sort(), [
      'durationMs',
      'instance',
      'level',
      'message',
      'requestId',
      'timestamp'
    ])
  })

  test("json format: a context-free call is byte-identical to today's output", () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('hello world')

    const line = logSpy.mock.calls[0]!.arguments[0] as string
    const parsed = JSON.parse(line)
    // -> Exactly the four fields the pre-context implementation ever produced, in the same order,
    //    with no stray `context` key left behind by an `undefined` merge.
    assert.deepEqual(Object.keys(parsed), ['timestamp', 'instance', 'level', 'message'])
    assert.equal(parsed.message, 'hello world')
    assert.equal(parsed.level, 'info')
    assert.equal(parsed.instance, 'test-instance')
  })

  test('a context key colliding with a fixed field loses to the fixed field', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('hello world', { message: 'spoofed', level: 'spoofed' })

    const line = logSpy.mock.calls[0]!.arguments[0] as string
    const parsed = JSON.parse(line)
    assert.equal(parsed.message, 'hello world')
    assert.equal(parsed.level, 'info')
  })

  test('text mode ignores a context object, unchanged from a context-free call', () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('hello world', { requestId: 'abc-123' })

    assert.equal(logSpy.mock.calls.length, 1)
    const line = logSpy.mock.calls[0]!.arguments[0] as string
    assert.match(line, /hello world$/)
    assert.doesNotMatch(line, /abc-123/)
  })
})
