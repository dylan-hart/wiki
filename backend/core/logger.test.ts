import assert from 'node:assert/strict'
import { afterEach, describe, mock, test } from 'node:test'
import logger from './logger.ts'

/**
 * Pure unit test: `logger.ts` reads only `WIKI.config.{logFormat,logLevel}` and `WIKI.INSTANCE_ID`,
 * so a minimal stand-in global is enough — no database, no other model.
 */
function setWiki(config: { logFormat: string; logLevel: string }) {
  ;(globalThis as any).WIKI = {
    config,
    INSTANCE_ID: 'test-instance'
  }
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
})
