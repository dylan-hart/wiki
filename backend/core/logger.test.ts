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

/**
 * The scoped-child half. Asserted in JSON mode throughout: that is the format in which the scope and
 * the merged fields are observable as data rather than as a rendered string.
 */
describe('logger scopes', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  function parseLines(logSpy: ReturnType<typeof mock.method>) {
    return logSpy.mock.calls.map((call) => JSON.parse(call.arguments[0] as string))
  }

  test("a child's scope and fields ride every line it emits", () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    const log = primaryLogger.scope('storage', { target: 'tgt-1', module: 'git' })
    log.info('sync started')
    log.warn('daily backup failed')
    log.error('working copy left mid-rebase')
    log.debug('nothing due')

    const lines = parseLines(logSpy)
    assert.equal(lines.length, 4)
    assert.deepEqual(
      lines.map((line) => line.level),
      ['info', 'warn', 'error', 'debug']
    )
    for (const line of lines) {
      assert.equal(line.scope, 'storage')
      assert.equal(line.target, 'tgt-1')
      assert.equal(line.module, 'git')
    }
    assert.equal(lines[0]!.message, 'sync started')
  })

  test("a call's own field overrides the child's", () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    const log = primaryLogger.scope('search', { engine: 'db' })
    log.info('reindexed', { engine: 'elasticsearch', pages: 12 })

    const [line] = parseLines(logSpy)
    assert.equal(line.scope, 'search')
    assert.equal(line.engine, 'elasticsearch')
    assert.equal(line.pages, 12)
  })

  test('the scope loses to the fixed fields, exactly as a context key does', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.scope('jobs', { level: 'spoofed', message: 'spoofed' }).info('job done')

    const [line] = parseLines(logSpy)
    assert.equal(line.level, 'info')
    assert.equal(line.message, 'job done')
    assert.equal(line.scope, 'jobs')
  })

  test('a fieldless child still stamps its scope, and adds nothing else', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.scope('collab').debug('peer joined')

    const [line] = parseLines(logSpy)
    assert.deepEqual(Object.keys(line).sort(), [
      'instance',
      'level',
      'message',
      'scope',
      'timestamp'
    ])
    assert.equal(line.scope, 'collab')
  })

  test("a child of a child takes the new scope and merges both parents' fields", () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    const storage = primaryLogger.scope('storage', { target: 'tgt-1', module: 'git' })
    storage.scope('pages', { module: 'sftp', page: 42 }).info('moved')

    const [line] = parseLines(logSpy)
    assert.equal(line.scope, 'pages')
    assert.equal(line.target, 'tgt-1')
    assert.equal(line.module, 'sftp')
    assert.equal(line.page, 42)
  })

  test('a child does not mutate the parent, nor a sibling child', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    const storage = primaryLogger.scope('storage', { target: 'tgt-1' })
    storage.scope('search', { engine: 'db' }).info('from the grandchild')
    storage.info('from the child')
    primaryLogger.info('from the parent')

    const [grandchild, child, parent] = parseLines(logSpy)
    assert.equal(grandchild!.engine, 'db')
    assert.equal(child!.scope, 'storage')
    assert.equal(child!.engine, undefined)
    assert.equal(parent!.scope, undefined)
    assert.equal(parent!.target, undefined)
  })

  test("a child is gated by `logLevel` exactly as the parent's own methods are", () => {
    setWiki({ logFormat: 'json', logLevel: 'warn' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    const log = primaryLogger.scope('db', { schema: 'public' })
    log.error('pool exhausted')
    log.warn('reconnecting')
    log.info('connected')
    log.debug('LISTEN registered')

    assert.deepEqual(
      parseLines(logSpy).map((line) => line.level),
      ['error', 'warn']
    )
  })

  test('a scoped line still reaches the backlog and the terminal socket', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    mock.method(console, 'log', () => {})

    const emitted: string[] = []
    primaryLogger.ws.on('log', (line: string) => emitted.push(line))
    primaryLogger.scope('mail', { to: 'nobody@example.com' }).warn('mail is not configured')

    assert.equal(emitted.length, 1)
    assert.match(emitted[0]!, /nobody@example\.com/)
    assert.deepEqual(primaryLogger.backlog(), emitted)
  })

  test('text mode renders a scoped line as it renders any other', () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.scope('icons', { prefix: 'mdi' }).info('icon set enabled')

    assert.equal(logSpy.mock.calls.length, 1)
    // -> Text mode ignores `context` wholesale today, so the child's fields are not rendered here —
    //    the text formatter is Task 1's (#2660), not this one's. What matters at this point is only
    //    that a scoped call goes through the same single renderer and is not dropped.
    assert.match(logSpy.mock.calls[0]!.arguments[0] as string, /icon set enabled$/)
  })
})
