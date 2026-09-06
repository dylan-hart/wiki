import assert from 'node:assert/strict'
import { styleText } from 'node:util'
import { afterEach, describe, mock, test } from 'node:test'
import logger, { renderJson, renderText } from './logger.ts'
import type { LogFrame } from './logger.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * Pure unit test: `logger.ts` reads only `WIKI.config.{logFormat,logLevel}` and `WIKI.INSTANCE_ID`,
 * so a minimal stand-in global is enough — no database, no other model.
 */
function setWiki(config: { logFormat?: unknown; logLevel?: unknown; logScopes?: unknown }) {
  installTestWiki({
    config,
    INSTANCE_ID: 'test-instance'
  })
}

/**
 * `node:util`'s `styleText` emits escapes only when it believes the stream is a colour-capable TTY,
 * which is true under a local `node --test` in a terminal and false in CI (and under `NO_COLOR`).
 * Every text-mode assertion runs through this so a suite proves the LAYOUT rather than the
 * environment's colour support — the colouring itself is asserted separately, and skipped when the
 * runner is not producing any.
 */
function stripAnsi(line: string): string {
  // oxlint-disable-next-line no-control-regex -- stripping ANSI escapes is the whole point
  return line.replaceAll(/\u001b\[[0-9;]*m/g, '')
}

/** Whether `styleText` is emitting escapes at all in this runner — see `stripAnsi` above. */
function colorsEnabled(): boolean {
  return styleText('dim', 'x') !== 'x'
}

describe('logger', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  test('json format serializes an Error into the error object, not {}', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.error('db', 'connecting failed', { error: new Error('boom') })

    assert.equal(logSpy.mock.calls.length, 1)
    const line = logSpy.mock.calls[0]!.arguments[0] as string
    const parsed = JSON.parse(line)
    assert.equal(parsed.level, 'error')
    // -> `Error` has no enumerable own properties, so `JSON.stringify`-ing one straight serialized
    //    it as `{}`, losing the stack exactly where structured logging was requested
    //    (OpenProject #939). The stack-as-message stand-in that fixed it is gone now that there is
    //    a real `error` field to put it in, so `message` can stay a sentence.
    assert.notEqual(JSON.stringify(parsed.error), '{}')
    assert.equal(parsed.message, 'connecting failed')
    assert.equal(parsed.error.name, 'Error')
    assert.equal(parsed.error.message, 'boom')
    assert.match(parsed.error.stack, /Error: boom/)
  })

  test('text format still renders an Error as its stack', () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.warn('db', 'query failed', { error: new Error('kaboom') })

    assert.equal(logSpy.mock.calls.length, 1)
    const line = logSpy.mock.calls[0]!.arguments[0] as string
    assert.match(line, /Error: kaboom/)
  })

  test('json format leaves a plain string message untouched', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('boot', 'hello world')

    const line = logSpy.mock.calls[0]!.arguments[0] as string
    const parsed = JSON.parse(line)
    assert.equal(parsed.message, 'hello world')
  })

  test('json format merges a context object as siblings of message', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('http', 'request handled', { requestId: 'abc-123', durationMs: 42 })

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
      'scope',
      'timestamp'
    ])
  })

  test('json format: a context-free call carries the five fixed fields and nothing else', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('boot', 'hello world')

    const line = logSpy.mock.calls[0]!.arguments[0] as string
    const parsed = JSON.parse(line)
    // -> The four the pre-scope implementation produced plus `scope`, in the same order, with no
    //    stray `context` key left behind by an `undefined` merge and no `error` key on a call that
    //    carried no error.
    assert.deepEqual(Object.keys(parsed), ['timestamp', 'instance', 'level', 'scope', 'message'])
    assert.equal(parsed.message, 'hello world')
    assert.equal(parsed.level, 'info')
    assert.equal(parsed.instance, 'test-instance')
  })

  test('a context key colliding with a fixed field loses to the fixed field', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('boot', 'hello world', { message: 'spoofed', level: 'spoofed' })

    const line = logSpy.mock.calls[0]!.arguments[0] as string
    const parsed = JSON.parse(line)
    assert.equal(parsed.message, 'hello world')
    assert.equal(parsed.level, 'info')
  })

  test('text mode renders a context object as a key=value tail (C1)', () => {
    // -> This assertion used to say the opposite: text mode threw the context away, so the one
    //    place the fork added request context (`apiErrorHandler`'s `{ reqId, method, url, … }`) was
    //    invisible unless the operator ran in JSON mode. Facts belong in fields in BOTH modes.
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('http', 'hello world', { requestId: 'abc-123' })

    assert.equal(logSpy.mock.calls.length, 1)
    const line = stripAnsi(logSpy.mock.calls[0]!.arguments[0] as string)
    assert.match(line, /hello world {2}requestId=abc-123$/)
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

    primaryLogger.error('boot', 'an error')
    primaryLogger.warn('boot', 'a warning')
    primaryLogger.info('boot', 'some info')
    primaryLogger.debug('boot', 'a debug line')

    const levels = logSpy.mock.calls.map(
      (call) => JSON.parse(call.arguments[0] as string).level as string
    )
    assert.deepEqual(levels, ['error', 'warn'])
  })

  test('the lowest level logs all four', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.error('boot', 'e')
    primaryLogger.warn('boot', 'w')
    primaryLogger.info('boot', 'i')
    primaryLogger.debug('boot', 'd')

    const levels = logSpy.mock.calls.map(
      (call) => JSON.parse(call.arguments[0] as string).level as string
    )
    assert.deepEqual(levels, ['error', 'warn', 'info', 'debug'])
  })
})

/**
 * Per-scope thresholds (OpenProject #2663). `logLevel` is the default for a scope that says nothing;
 * a `logScopes` entry or a live override thunk answers for that scope instead.
 *
 * The gate that decides this had to move from the level loop (which stopped attaching listeners past
 * `logLevel`) to inside the listener, since the scope is not known until the call has been
 * normalized — so the first claim below is the behaviour-preservation one: with no overrides at all,
 * nothing about the old threshold changed.
 */
describe('logger per-scope thresholds', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  /** Every line the run emitted, as `<level> <scope>` pairs, in order. */
  function emitted(logSpy: { mock: { calls: { arguments: unknown[] }[] } }): string[] {
    return logSpy.mock.calls.map((call) => {
      const parsed = JSON.parse(call.arguments[0] as string)
      return `${parsed.level} ${parsed.scope}`
    })
  }

  test('with no logScopes and no thunk, the global level still decides everything', () => {
    setWiki({ logFormat: 'json', logLevel: 'info' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.warn('storage', 'a warning')
    primaryLogger.info('storage', 'some info')
    primaryLogger.debug('storage', 'a debug line')
    primaryLogger.debug('jobs', 'another debug line')

    assert.deepEqual(emitted(logSpy), ['warn storage', 'info storage'])
  })

  test('a logScopes entry raises one scope and leaves every other one at the global level', () => {
    setWiki({ logFormat: 'json', logLevel: 'info', logScopes: { storage: 'debug' } })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.debug('storage', 'a storage debug line')
    primaryLogger.debug('jobs', 'a jobs debug line')
    primaryLogger.info('jobs', 'a jobs info line')

    assert.deepEqual(emitted(logSpy), ['debug storage', 'info jobs'])
  })

  test('a logScopes entry can quieten a scope below the global level too', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug', logScopes: { sql: 'error' } })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.debug('sql', 'select 1')
    primaryLogger.warn('sql', 'a slow query')
    primaryLogger.error('sql', 'a broken query')
    primaryLogger.debug('jobs', 'still chatty')

    assert.deepEqual(emitted(logSpy), ['error sql', 'debug jobs'])
  })

  test('the override thunk wins over the config map, and is re-read on every line', () => {
    setWiki({ logFormat: 'json', logLevel: 'info', logScopes: { sql: 'error' } })
    let sqlOn = false
    const primaryLogger = logger.init({
      scopeOverrides: () => (sqlOn ? { sql: 'debug' as const } : {})
    })
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.debug('sql', 'before the flag')
    // -> The point of the thunk: an administrator flips `sqlLog` mid-run and the very next query
    //    line is logged, with no restart and no second logger.
    sqlOn = true
    primaryLogger.debug('sql', 'after the flag')
    sqlOn = false
    primaryLogger.debug('sql', 'after turning it back off')

    assert.deepEqual(emitted(logSpy), ['debug sql'])
    assert.equal(JSON.parse(logSpy.mock.calls[0]!.arguments[0] as string).message, 'after the flag')
  })

  test('a scope the thunk does not name still falls through to the config map', () => {
    setWiki({ logFormat: 'json', logLevel: 'info', logScopes: { storage: 'debug' } })
    const primaryLogger = logger.init({ scopeOverrides: () => ({ sql: 'debug' as const }) })
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.debug('sql', 'from the thunk')
    primaryLogger.debug('storage', 'from the config map')
    primaryLogger.debug('jobs', 'from neither')

    assert.deepEqual(emitted(logSpy), ['debug sql', 'debug storage'])
  })

  test('a scoped child is gated by its own scope, exactly as a direct call is', () => {
    setWiki({ logFormat: 'json', logLevel: 'info', logScopes: { storage: 'debug' } })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.scope('storage', { module: 'git' }).debug('pulling from the remote')
    primaryLogger.scope('jobs').debug('nothing due')

    assert.deepEqual(emitted(logSpy), ['debug storage'])
    assert.equal(JSON.parse(logSpy.mock.calls[0]!.arguments[0] as string).module, 'git')
  })

  test('a raised scope reaches the backlog and the terminal socket, not just stdout', () => {
    setWiki({ logFormat: 'json', logLevel: 'info', logScopes: { sql: 'debug' } })
    const primaryLogger = logger.init()
    mock.method(console, 'log', () => {})
    const frames: LogFrame[] = []
    primaryLogger.ws.on('log', (frame: LogFrame) => frames.push(frame))

    primaryLogger.debug('sql', 'select 1')
    primaryLogger.debug('jobs', 'nothing due')

    assert.deepEqual(
      frames.map((frame) => frame.scope),
      ['sql']
    )
    assert.deepEqual(
      primaryLogger.backlog().map((frame) => frame.scope),
      ['sql']
    )
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
    for (const logFormat of ['text', 'json']) {
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
      setWiki({ logFormat: 'text', logLevel })
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

  for (const logFormat of ['default', 'Text', 'JSON', 'jsno', '', undefined]) {
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
      assert.match(line, /text, json/)
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

  /**
   * `logScopes` is validated the same way and for the same reason as `logLevel` (OpenProject #2647's
   * shape): a typo'd scope name is a scope nothing is ever measured against, so an operator who
   * asked to trace `storge` would see nothing and be told nothing about why.
   */
  test('accepts a logScopes map naming real scopes and real levels', () => {
    setWiki({
      logFormat: 'text',
      logLevel: 'info',
      logScopes: { http: 'debug', sql: 'error', storage: 'debug' }
    })
    const errorSpy = mock.method(console, 'error', () => {})
    const exit = mock.fn()

    logger.init({ exit })

    assert.equal(exit.mock.calls.length, 0)
    assert.equal(errorSpy.mock.calls.length, 0)
  })

  for (const logScopes of [undefined, null, {}]) {
    test(`accepts an absent logScopes map (${JSON.stringify(logScopes)})`, () => {
      setWiki({ logFormat: 'text', logLevel: 'info', logScopes })
      const errorSpy = mock.method(console, 'error', () => {})
      const exit = mock.fn()

      logger.init({ exit })

      assert.equal(exit.mock.calls.length, 0)
      assert.equal(errorSpy.mock.calls.length, 0)
    })
  }

  for (const scope of ['storge', 'HTTP', 'legacy', '']) {
    test(`refuses to boot on an unknown logScopes scope ${JSON.stringify(scope)}`, () => {
      setWiki({ logFormat: 'text', logLevel: 'info', logScopes: { [scope]: 'debug' } })
      const errorSpy = mock.method(console, 'error', () => {})
      const exit = mock.fn()

      logger.init({ exit })

      assert.deepEqual(
        exit.mock.calls.map((call) => call.arguments),
        [[1]]
      )
      assert.equal(errorSpy.mock.calls.length, 1)
      const line = errorSpy.mock.calls[0]!.arguments[0] as string
      assert.match(line, /logScopes/)
      assert.ok(line.includes(JSON.stringify(scope)), 'names the rejected scope')
      // -> The whole vocabulary, so the operator can find the name they meant without opening the
      //    source.
      assert.match(line, /boot, config, db, sql, http/)
    })
  }

  for (const level of ['Debug', 'verbose', 'trace', '', null]) {
    test(`refuses to boot on an invalid logScopes level ${JSON.stringify(level)}`, () => {
      setWiki({ logFormat: 'text', logLevel: 'info', logScopes: { storage: level } })
      const errorSpy = mock.method(console, 'error', () => {})
      const exit = mock.fn()

      logger.init({ exit })

      assert.deepEqual(
        exit.mock.calls.map((call) => call.arguments),
        [[1]]
      )
      const line = errorSpy.mock.calls[0]!.arguments[0] as string
      assert.match(line, /logScopes\.storage/)
      assert.match(line, /error, warn, info, debug/)
    })
  }

  for (const logScopes of ['debug', 42, ['storage']]) {
    test(`refuses to boot when logScopes is not a map (${JSON.stringify(logScopes)})`, () => {
      setWiki({ logFormat: 'text', logLevel: 'info', logScopes })
      const errorSpy = mock.method(console, 'error', () => {})
      const exit = mock.fn()

      logger.init({ exit })

      assert.deepEqual(
        exit.mock.calls.map((call) => call.arguments),
        [[1]]
      )
      assert.match(errorSpy.mock.calls[0]!.arguments[0] as string, /logScopes/)
    })
  }

  test('reports every bad logScopes entry, not just the first', () => {
    setWiki({
      logFormat: 'text',
      logLevel: 'info',
      logScopes: { storge: 'debug', storage: 'verbose' }
    })
    const errorSpy = mock.method(console, 'error', () => {})
    const exit = mock.fn()

    logger.init({ exit })

    // -> Production's `exit` is `process.exit` and never returns, so only the first is ever reached
    //    there; the injected stub returning is what lets this prove neither entry is skipped.
    assert.equal(exit.mock.calls.length, 2)
    assert.equal(errorSpy.mock.calls.length, 2)
  })

  test('the returned logger has no verbose or silly method', () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init() as any

    // -> They were no-op stubs, which is what made `logLevel: verbose` look like a supported
    //    configuration rather than the ignored value it was (OpenProject #2647).
    assert.equal(primaryLogger.verbose, undefined)
    assert.equal(primaryLogger.silly, undefined)
  })
})

/**
 * The text renderer: `<ISO ts> <level padded 5> <scope padded 8>  <message>  <k=v …>`, with the
 * stack — where the level warrants one — on following lines indented two spaces.
 *
 * Every layout assertion runs the line through `stripAnsi` so it proves the shape rather than the
 * runner's colour support; the colouring itself has its own describe below.
 */
describe('logger text renderer', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  function renderOne(
    call: (log: ReturnType<typeof logger.init>) => void,
    logLevel = 'debug'
  ): string {
    setWiki({ logFormat: 'text', logLevel })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})
    call(primaryLogger)
    assert.equal(logSpy.mock.calls.length, 1)
    return stripAnsi(logSpy.mock.calls[0]!.arguments[0] as string)
  }

  test('lays out timestamp, level, scope and message in fixed columns', () => {
    const line = renderOne((log) => log.info('db', 'connected'))

    // -> `level` padded to 5 plus a separator space, `scope` padded to 8 plus TWO — which is what
    //    puts the message at a fixed offset whatever the scope's length, so a tailed log reads as
    //    columns. Checked against the spec's own sample block (2.1), not re-derived.
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z info {2}db {8}connected$/)
  })

  test('the message column starts at the same offset whatever the scope', () => {
    const short = renderOne((log) => log.info('db', 'connected'))
    const long = renderOne((log) => log.info('terminal', 'connected'))

    assert.equal(short.indexOf('connected'), long.indexOf('connected'))
  })

  test('carries no instance id — that stays on the JSON record', () => {
    const line = renderOne((log) => log.info('boot', 'ready'))

    assert.doesNotMatch(line, /test-instance/)
  })

  test('renders fields as a space-separated key=value tail, two spaces after the message', () => {
    const line = renderOne((log) =>
      log.info('jobs', 'scheduler started', { workers: 7, planned: 11 })
    )

    assert.match(line, /scheduler started {2}workers=7 planned=11$/)
  })

  test('quotes a value containing a space, leaves a bare one alone', () => {
    const line = renderOne((log) =>
      log.warn('storage', 'daily backup failed', { target: 'git', reason: 'remote not reachable' })
    )

    assert.match(line, /target=git reason="remote not reachable"$/)
  })

  test('humanises ms, and puts it last in the tail', () => {
    const sub = renderOne((log) => log.info('db', 'connected', { migrations: 0, ms: 528 }))
    const over = renderOne((log) => log.info('boot', 'ready', { sites: 1, ms: 3900 }))

    // -> Sub-second stays in milliseconds (the resolution that matters there); anything longer
    //    reads as seconds to one decimal. Never `ms=528`, which is the JSON spelling.
    assert.match(sub, /migrations=0 in 528ms$/)
    assert.match(over, /sites=1 in 3\.9s$/)
    assert.doesNotMatch(sub, /ms=528/)
  })

  test('renders an error inline as error="<message>" and the stack indented two spaces', () => {
    const err = new Error('fetching locale metadata failed: 404')
    const line = renderOne((log) =>
      log.error('jobs', 'updateLocales failed, no attempts left', { attempts: 3, error: err })
    )

    const [head, ...stack] = line.split('\n')
    assert.match(head!, /attempts=3 error="fetching locale metadata failed: 404"$/)
    assert.ok(stack.length > 0, 'expected the stack on following lines')
    // -> Two spaces, so the trace reads as a continuation of the record above it rather than as
    //    another record.
    assert.ok(
      stack.every((stackLine) => stackLine.startsWith('  ')),
      `expected every stack line indented two spaces, got ${JSON.stringify(stack)}`
    )
    assert.match(stack[0]!, /^ {2}Error: fetching locale metadata failed: 404$/)
  })

  test('suppresses a warn stack at logLevel info, and prints it at debug', () => {
    const err = new Error('remote unreachable')
    const atInfo = renderOne((log) => log.warn('storage', 'sync degraded', { error: err }), 'info')
    const atDebug = renderOne(
      (log) => log.warn('storage', 'sync degraded', { error: err }),
      'debug'
    )

    // -> A stack is noise on a warning the operator has already decided to live with; it is the
    //    whole record on an error. `warn` gets one only when they have asked for everything.
    assert.match(atInfo, /error="remote unreachable"$/)
    assert.doesNotMatch(atInfo, /\n/)
    assert.match(atDebug, /\n {2}Error: remote unreachable/)
  })

  test('always prints an error stack at error level, even at logLevel error', () => {
    const err = new Error('boom')
    const line = renderOne((log) => log.error('db', 'connection lost', { error: err }), 'error')

    assert.match(line, /\n {2}Error: boom/)
  })

  test('a non-Error `error` field stays an ordinary field, with no invented stack', () => {
    const line = renderOne((log) => log.warn('auth', 'strategy refused', { error: 'bad_request' }))

    assert.match(line, /error=bad_request$/)
    assert.doesNotMatch(line, /\n/)
  })

  test('dims the timestamp, scope and keys and colours the level and an error message', (t) => {
    if (!colorsEnabled()) {
      t.skip('styleText is not emitting escapes in this runner')
      return
    }
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.error('db', 'connection lost', { host: 'db1' })
    primaryLogger.info('db', 'connected')

    const errorLine = logSpy.mock.calls[0]!.arguments[0] as string
    const infoLine = logSpy.mock.calls[1]!.arguments[0] as string

    assert.ok(errorLine.includes(styleText('dim', 'db'.padEnd(8))), 'scope should be dim')
    assert.ok(errorLine.includes(styleText('dim', 'host')), 'a tail key should be dim')
    assert.ok(errorLine.includes(styleText('red', 'error')), 'error level should be red')
    assert.ok(
      errorLine.includes(styleText('red', 'connection lost')),
      'error message should be red'
    )
    // -> `info` is deliberately plain, level and message both: the level IS the status, so the
    //    quiet case needs no colour of its own and a `warn` stays visible after a week of tailing.
    assert.ok(infoLine.includes(' info  '), 'info level should be written unwrapped')
    assert.ok(!infoLine.includes(styleText('dim', 'info ')))
    assert.ok(!infoLine.includes(styleText('red', 'connected')))
  })
})

/**
 * `(scope, message, fields?)` is the ONLY call shape (OpenProject #2668).
 *
 * There used to be a second — the legacy `(msg, context?)` overload #2660 kept while the three area
 * sweeps ran, filed under a sentinel scope `legacy` so a grep over the output said how much was
 * left — and a describe here asserting it rendered. Both are gone: a call missing its scope is a
 * `tsc` error now, which is exactly what proves the sweeps finished, so the coverage that matters
 * lives in the type checker and not in a runtime assertion.
 *
 * What survives from that describe is the half that is still about behaviour rather than about the
 * bridge: an `Error` handed to the logger reaches the record as `{ name, message, stack }`, whether
 * it arrives on a parent call or through a scoped child.
 */
describe('logger single call shape', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  test('the scope, the message and the fields each land in their own place', () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.warn('http', 'request rejected', { reqId: 'req-1q' })

    const line = stripAnsi(logSpy.mock.calls[0]!.arguments[0] as string)
    assert.match(line, / warn {2}http {6}request rejected {2}reqId=req-1q$/)
  })

  test('an Error in the fields becomes the error field, message and stack intact', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.warn('http', 'request rejected', { reqId: 'req-1q', error: new Error('kaboom') })

    const parsed = JSON.parse(logSpy.mock.calls[0]!.arguments[0] as string)
    assert.equal(parsed.scope, 'http')
    assert.equal(parsed.message, 'request rejected')
    assert.equal(parsed.reqId, 'req-1q')
    assert.equal(parsed.error.message, 'kaboom')
    assert.match(parsed.error.stack, /Error: kaboom/)
  })

  test('a non-Error `error` field stays an ordinary field rather than being promoted', () => {
    // -> `normalizeCall` lifts `fields.error` into the record's own slot only when it really is an
    //    `Error`; a route that logs `{ error: 'ECONNREFUSED' }` keeps a plain string field and gets
    //    no invented `name`/`stack`.
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.warn('db', 'connection refused', { error: 'ECONNREFUSED' })

    const parsed = JSON.parse(logSpy.mock.calls[0]!.arguments[0] as string)
    assert.equal(parsed.error, 'ECONNREFUSED')
  })
})

describe('logger backlog', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  test('keeps the last 500 frames and drops the oldest beyond that', () => {
    // -> 100 was minutes of heartbeat ticks; with those demoted to `debug`, 500 is hours of real
    //    history for an admin terminal that connects after the fact.
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    mock.method(console, 'log', () => {})

    for (let i = 0; i < 505; i += 1) {
      primaryLogger.info('jobs', `line ${i}`)
    }

    const backlog = primaryLogger.backlog()
    assert.equal(backlog.length, 500)
    assert.equal(backlog[0]!.message, 'line 5')
    assert.equal(backlog[499]!.message, 'line 504')
  })

  test('the backlog holds frames, not rendered lines (OpenProject #2679)', () => {
    /*
      Deliberately in TEXT mode: what the admin terminal replays must not depend on how this process
      happens to be writing its own stdout, which is the whole reason the element type changed.
    */
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    mock.method(console, 'log', () => {})

    primaryLogger.info('db', 'connected', { schema: 'public', ms: 528 })

    const [frame] = primaryLogger.backlog()
    assert.ok(frame)
    assert.deepEqual(Object.keys(frame).sort(), [
      'fields',
      'instance',
      'level',
      'message',
      'scope',
      'timestamp'
    ])
    assert.equal(frame.instance, 'test-instance')
    assert.equal(frame.level, 'info')
    assert.equal(frame.scope, 'db')
    assert.equal(frame.message, 'connected')
    assert.deepEqual(frame.fields, { schema: 'public', ms: 528 })
    assert.match(frame.timestamp, /^\d{4}-\d{2}-\d{2}T/)
    // -> No ANSI, no padding, no `key=value` tail: nothing of the text renderer leaked into it
    assert.ok(!JSON.stringify(frame).includes(''))
  })

  test('the ws frame is the very same frame the backlog kept', () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})
    const frames: LogFrame[] = []
    primaryLogger.ws.on('log', (frame: LogFrame) => frames.push(frame))

    primaryLogger.info('db', 'connected', { ms: 528 })

    assert.equal(frames.length, 1)
    assert.deepEqual(frames, primaryLogger.backlog())
    // -> stdout still gets the rendered line; only the socket and the backlog changed
    assert.equal(typeof logSpy.mock.calls[0]!.arguments[0], 'string')
    assert.equal(logSpy.mock.calls[0]!.arguments[0], renderText(frames[0]!))
  })

  test('an error rides the frame as a serialisable field and a top-level stack', () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    mock.method(console, 'log', () => {})

    primaryLogger.error('jobs', 'purgeUploads failed', {
      job: 'job-1',
      attempt: 3,
      error: new Error('disk full')
    })

    const [frame] = primaryLogger.backlog()
    assert.ok(frame)
    assert.deepEqual(frame.fields.error, {
      name: 'Error',
      message: 'disk full',
      stack: (frame.fields.error as { stack: string }).stack
    })
    assert.match(frame.stack!, /Error: disk full/)
    assert.equal(frame.stack, (frame.fields.error as { stack: string }).stack)
    // -> Last in `fields`, which is what keeps the text tail reading `job=… attempt=… error=… in …`
    assert.deepEqual(Object.keys(frame.fields), ['job', 'attempt', 'error'])
  })

  test('a field JSON cannot represent is stringified rather than dropped or thrown on', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    mock.method(console, 'log', () => {})

    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular

    primaryLogger.warn('cluster', 'odd payload', {
      circular,
      missing: undefined,
      big: 9007199254740993n,
      fn: function handler() {},
      nested: { cause: new Error('inner') }
    })

    const [frame] = primaryLogger.backlog()
    assert.ok(frame)
    assert.equal(typeof frame.fields.circular, 'string')
    assert.equal(frame.fields.missing, 'undefined')
    assert.equal(frame.fields.big, '9007199254740993')
    assert.match(frame.fields.fn as string, /handler/)
    // -> A nested `Error` is serialised too, not just the top-level one
    assert.equal((frame.fields.nested as any).cause.message, 'inner')
    // -> The point of all of the above: the frame survives being put on the wire
    assert.doesNotThrow(() => JSON.stringify(frame))
  })
})

/**
 * The two renderers, driven directly off a hand-built frame — which is the payoff of #2679's split:
 * neither needs a logger instance, a `WIKI` global or a `console.log` spy any more.
 */
describe('logger renderers', () => {
  const frame: LogFrame = {
    timestamp: '2026-09-06T07:00:00.000Z',
    instance: 'inst-a',
    level: 'error',
    scope: 'jobs',
    message: 'purgeUploads failed',
    fields: {
      job: 'job-1',
      ms: 3900,
      error: { name: 'Error', message: 'disk full', stack: 'Error: disk full\n    at nowhere' }
    },
    stack: 'Error: disk full\n    at nowhere'
  }

  test('renderJson spreads the fields under the fixed keys', () => {
    const parsed = JSON.parse(renderJson(frame))
    assert.deepEqual(parsed, {
      job: 'job-1',
      ms: 3900,
      error: { name: 'Error', message: 'disk full', stack: 'Error: disk full\n    at nowhere' },
      timestamp: '2026-09-06T07:00:00.000Z',
      instance: 'inst-a',
      level: 'error',
      scope: 'jobs',
      message: 'purgeUploads failed'
    })
  })

  test('renderJson lets a fixed key win a collision with a field of the same name', () => {
    const parsed = JSON.parse(
      renderJson({ ...frame, fields: { level: 'debug', scope: 'nonsense' } })
    )
    assert.equal(parsed.level, 'error')
    assert.equal(parsed.scope, 'jobs')
  })

  test('renderText puts the error message in the tail and the duration last', () => {
    assert.equal(
      stripAnsi(renderText(frame)),
      '2026-09-06T07:00:00.000Z error jobs      purgeUploads failed  job=job-1 error="disk full" in 3.9s'
    )
  })

  test('renderText appends the stack only when asked for it', () => {
    assert.ok(!renderText(frame).includes('at nowhere'))
    // -> Every stack line gains two spaces, so the frame's own four-space `at …` indent becomes six
    assert.match(
      stripAnsi(renderText(frame, { withStack: true })),
      /\n {2}Error: disk full\n {6}at nowhere$/
    )
  })

  test('renderText round-trips a frame with no fields and no error', () => {
    assert.equal(
      stripAnsi(
        renderText({
          timestamp: '2026-09-06T07:00:00.000Z',
          instance: 'inst-a',
          level: 'info',
          scope: 'boot',
          message: 'ready',
          fields: {}
        })
      ),
      '2026-09-06T07:00:00.000Z info  boot      ready'
    )
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
    primaryLogger.info('boot', 'from the parent')

    const [grandchild, child, parent] = parseLines(logSpy)
    assert.equal(grandchild!.engine, 'db')
    assert.equal(child!.scope, 'storage')
    assert.equal(child!.engine, undefined)
    // -> The parent names its own scope, and what matters here is that it is NOT `storage` — the
    //    child never wrote its scope or its fields back onto the logger it was built from.
    assert.equal(parent!.scope, 'boot')
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

    const emitted: LogFrame[] = []
    primaryLogger.ws.on('log', (frame: LogFrame) => emitted.push(frame))
    primaryLogger.scope('mail', { to: 'nobody@example.com' }).warn('mail is not configured')

    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]!.scope, 'mail')
    assert.deepEqual(emitted[0]!.fields, { to: 'nobody@example.com' })
    assert.deepEqual(primaryLogger.backlog(), emitted)
  })

  test('text mode renders a scoped line as it renders any other', () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.scope('icons', { prefix: 'mdi' }).info('icon set enabled')

    assert.equal(logSpy.mock.calls.length, 1)
    // -> The child's scope lands in the scope column and its fields in the `key=value` tail, which is
    //    the point: a scoped call goes through the one renderer and comes out indistinguishable from
    //    the same call written out in full.
    assert.match(
      stripAnsi(logSpy.mock.calls[0]!.arguments[0] as string),
      /\binfo\s+icons\s+icon set enabled {2}prefix=mdi$/
    )
  })
})

/**
 * OpenProject #2678 (audit finding C7) - a regression guard, not a fix: the fix is #2679's frame,
 * asserted above, plus the Live Log page that colours off `frame.level` rather than off escapes.
 *
 * The Bug was that `util.styleText` returns bare text when stdout is not a TTY (Node 22.13+
 * validates the stream by default), so under Docker, systemd or any log pipe the admin Terminal --
 * which was handed the rendered stdout line verbatim -- received no escapes at all and drew every
 * level in one colour. `validateStream: false` was the tempting local patch and is the wrong one:
 * it would put escapes into `docker logs` instead.
 *
 * What makes the page's colour independent of the server's TTY is that the two renderers are
 * separate -- `renderText` writes for stdout, while the socket and the backlog carry the FRAME --
 * so that is what this asserts, in text mode, the only mode where an escape could leak.
 * Deliberately no assertion on rendered message text: the invariant is the shape and the absence of
 * the escape byte, so a reworded line cannot break it.
 */
describe('the admin Live Log stream carries frames, never a rendered line (#2678)', () => {
  /** The byte every ANSI sequence opens with, built rather than pasted so the source stays text. */
  const ESC = String.fromCharCode(27)

  afterEach(() => {
    mock.restoreAll()
  })

  test('the socket and the backlog get the frame object, not the string console.log got', () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    const emitted: LogFrame[] = []
    primaryLogger.ws.on('log', (frame: LogFrame) => emitted.push(frame))
    primaryLogger.warn('db', 'reconnecting', { attempt: 2 })

    assert.equal(emitted.length, 1)
    const frame = emitted[0]!
    // -> The regression is exactly "the socket was handed the rendered line": a string here, equal
    //    to what stdout got, is the pre-#2679 behaviour C7 described.
    assert.equal(typeof frame, 'object')
    assert.equal(typeof logSpy.mock.calls[0]!.arguments[0], 'string')
    assert.equal(frame.level, 'warn')
    assert.equal(frame.scope, 'db')
    assert.equal(frame.message, 'reconnecting')
    assert.deepEqual(frame.fields, { attempt: 2 })
    assert.deepEqual(primaryLogger.backlog(), emitted)
  })

  test('no ANSI escape can reach the socket, at any level, in text mode', () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    mock.method(console, 'log', () => {})

    const emitted: LogFrame[] = []
    primaryLogger.ws.on('log', (frame: LogFrame) => emitted.push(frame))
    // -> Every level, because the colour was per-level: `error` red, `warn` yellow, `debug` dim.
    //    The `error` field and its stack ride along too, being the longest strings on a frame and
    //    the ones a renderer would have coloured.
    primaryLogger.error('db', 'pool exhausted', { error: new Error('too many clients') })
    primaryLogger.warn('db', 'reconnecting')
    primaryLogger.info('db', 'connected')
    primaryLogger.debug('db', 'LISTEN registered')

    assert.equal(emitted.length, 4)
    for (const frame of emitted) {
      // -> `JSON.stringify(frame)` is byte-for-byte what `controllers/terminal.ts` sends down the
      //    websocket, so asserting on it covers `message`, `scope` and every field at once --
      //    including the stack -- rather than a property list that could grow past the test.
      assert.equal(JSON.stringify(frame).includes(ESC), false)
    }
  })

  test('the colour stays where it belongs, on the stdout line', { skip: !colorsEnabled() }, () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    const emitted: LogFrame[] = []
    primaryLogger.ws.on('log', (frame: LogFrame) => emitted.push(frame))
    primaryLogger.error('db', 'pool exhausted')

    // -> The other half of the split, and the reason `validateStream: false` is not the fix: a
    //    person tailing a real terminal still gets a red `error`. Skipped when the runner is not
    //    colouring at all (CI, `NO_COLOR`) -- which is precisely the non-TTY condition the Bug was
    //    about, and where the assertion above is the one that matters.
    assert.equal((logSpy.mock.calls[0]!.arguments[0] as string).includes(ESC), true)
    assert.equal(JSON.stringify(emitted[0]!).includes(ESC), false)
  })
})
