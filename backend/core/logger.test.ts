import assert from 'node:assert/strict'
import { afterEach, describe, mock, test } from 'node:test'
import logger from './logger.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * Pure unit test: `logger.ts` reads only `WIKI.config.{logFormat,logLevel}` and `WIKI.INSTANCE_ID`,
 * so a minimal stand-in global is enough — no database, no other model.
 */
function setWiki(config: { logFormat?: unknown; logLevel?: unknown }) {
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
    setWiki({ logFormat: 'default', logLevel: 'debug' })
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
    setWiki({ logFormat: 'default', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('hello world', { requestId: 'abc-123' })

    assert.equal(logSpy.mock.calls.length, 1)
    const line = logSpy.mock.calls[0]!.arguments[0] as string
    assert.match(line, /hello world$/)
    assert.doesNotMatch(line, /abc-123/)
  })
})

describe('logger threshold', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  test('a valid level logs itself and everything above it, and nothing below', () => {
    setWiki({ logFormat: 'json', logLevel: 'warn' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.error('an error')
    primaryLogger.warn('a warning')
    primaryLogger.info('some info')
    primaryLogger.debug('a debug line')

    const levels = logSpy.mock.calls.map(
      (call) => JSON.parse(call.arguments[0] as string).level as string
    )
    assert.deepEqual(levels, ['error', 'warn'])
  })

  test('the lowest level logs all four', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.error('e')
    primaryLogger.warn('w')
    primaryLogger.info('i')
    primaryLogger.debug('d')

    const levels = logSpy.mock.calls.map(
      (call) => JSON.parse(call.arguments[0] as string).level as string
    )
    assert.deepEqual(levels, ['error', 'warn', 'info', 'debug'])
  })
})

describe('logger config validation', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  /**
   * Every level and format the app supports boots without complaint. The counterpart to the refusal
   * cases below: a validator that rejected a valid value would be caught here rather than in
   * production.
   */
  for (const logLevel of ['error', 'warn', 'info', 'debug']) {
    for (const logFormat of ['default', 'json']) {
      test(`accepts logLevel '${logLevel}' with logFormat '${logFormat}'`, () => {
        setWiki({ logFormat, logLevel })
        const errorSpy = mock.method(console, 'error', () => {})
        const exit = mock.fn()

        logger.init({ exit })

        assert.equal(exit.mock.calls.length, 0)
        assert.equal(errorSpy.mock.calls.length, 0)
      })
    }
  }

  /**
   * Each of these used to match no level in the walk, leaving every listener attached — so the
   * instance logged at `debug` with no indication the configured value had been ignored.
   * `verbose`/`silly` are the 2.x names this logger has never implemented; the rest are ordinary
   * typos, including a wrong-case one, since the sample config's values are lowercase.
   */
  for (const logLevel of ['Info', 'INFO', 'warning', 'verbose', 'silly', 'trace', '', undefined]) {
    test(`refuses to boot on logLevel ${JSON.stringify(logLevel)}`, () => {
      setWiki({ logFormat: 'default', logLevel })
      const errorSpy = mock.method(console, 'error', () => {})
      const exit = mock.fn()

      logger.init({ exit })

      assert.deepEqual(
        exit.mock.calls.map((call) => call.arguments),
        [[1]]
      )
      assert.equal(errorSpy.mock.calls.length, 1)
      const line = errorSpy.mock.calls[0]!.arguments[0] as string
      assert.match(line, /logLevel/)
      assert.match(line, /error, warn, info, debug/)
      // -> The offending value itself, so an operator can see what the merged config actually held.
      assert.ok(
        line.includes(JSON.stringify(logLevel) ?? 'undefined'),
        `expected ${JSON.stringify(line)} to name the rejected value`
      )
    })
  }

  for (const logFormat of ['text', 'Default', 'JSON', 'jsno', '', undefined]) {
    test(`refuses to boot on logFormat ${JSON.stringify(logFormat)}`, () => {
      setWiki({ logFormat, logLevel: 'info' })
      const errorSpy = mock.method(console, 'error', () => {})
      const exit = mock.fn()

      logger.init({ exit })

      assert.deepEqual(
        exit.mock.calls.map((call) => call.arguments),
        [[1]]
      )
      assert.equal(errorSpy.mock.calls.length, 1)
      const line = errorSpy.mock.calls[0]!.arguments[0] as string
      assert.match(line, /logFormat/)
      assert.match(line, /default, json/)
    })
  }

  test('reports both values when both are invalid', () => {
    setWiki({ logFormat: 'yaml', logLevel: 'silly' })
    const errorSpy = mock.method(console, 'error', () => {})
    const exit = mock.fn()

    logger.init({ exit })

    // -> Production's `exit` is `process.exit`, which never returns, so only the first line is ever
    //    reached there. The injected stub does return, which is what lets this assert that neither
    //    check is skipped once the other has already failed.
    assert.equal(exit.mock.calls.length, 2)
    assert.equal(errorSpy.mock.calls.length, 2)
    assert.match(errorSpy.mock.calls[0]!.arguments[0] as string, /logLevel/)
    assert.match(errorSpy.mock.calls[1]!.arguments[0] as string, /logFormat/)
  })

  test('the returned logger has no verbose or silly method', () => {
    setWiki({ logFormat: 'default', logLevel: 'debug' })
    const primaryLogger = logger.init() as any

    // -> They were no-op stubs, which is what made `logLevel: verbose` look like a supported
    //    configuration rather than the ignored value it was (OpenProject #2647).
    assert.equal(primaryLogger.verbose, undefined)
    assert.equal(primaryLogger.silly, undefined)
  })
})
