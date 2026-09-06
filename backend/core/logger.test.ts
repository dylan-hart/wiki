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
function setWiki(config: { logFormat?: unknown; logLevel?: unknown }) {
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

    primaryLogger.error(new Error('boom'))

    assert.equal(logSpy.mock.calls.length, 1)
    const line = logSpy.mock.calls[0]!.arguments[0] as string
    const parsed = JSON.parse(line)
    assert.equal(parsed.level, 'error')
    // -> `Error` has no enumerable own properties, so `JSON.stringify`-ing one straight serialized
    //    it as `{}`, losing the stack exactly where structured logging was requested
    //    (OpenProject #939). The stack-as-message stand-in that fixed it is gone now that there is
    //    a real `error` field to put it in, so `message` can stay a sentence.
    assert.notEqual(JSON.stringify(parsed.error), '{}')
    assert.equal(parsed.message, 'boom')
    assert.equal(parsed.error.name, 'Error')
    assert.equal(parsed.error.message, 'boom')
    assert.match(parsed.error.stack, /Error: boom/)
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
      'scope',
      'timestamp'
    ])
  })

  test('json format: a context-free call carries the five fixed fields and nothing else', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('hello world')

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

    primaryLogger.info('hello world', { message: 'spoofed', level: 'spoofed' })

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

    primaryLogger.info('hello world', { requestId: 'abc-123' })

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
 * The legacy `(msg, context?)` shape stays accepted for the duration of Phase 2 — 480-odd call
 * sites still use it — and is filed under the sentinel scope `legacy` so a grep over the output
 * says how much of the sweep is left. Phase 2's last task (#2668) deletes it.
 */
describe('logger dual call shape', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  test('text: a legacy call renders under scope legacy, context and all', () => {
    setWiki({ logFormat: 'text', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.warn('Something Happened.', { reqId: 'req-1q' })

    const line = stripAnsi(logSpy.mock.calls[0]!.arguments[0] as string)
    assert.match(line, / warn {2}legacy {4}Something Happened\. {2}reqId=req-1q$/)
  })

  test('json: a legacy call carries scope "legacy"', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('Something Happened.')

    const parsed = JSON.parse(logSpy.mock.calls[0]!.arguments[0] as string)
    assert.equal(parsed.scope, 'legacy')
    assert.equal(parsed.message, 'Something Happened.')
  })

  test('both shapes render off the same call, in the same format', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.info('db', 'connected', { schema: 'public' })
    primaryLogger.info('connected', { schema: 'public' })

    const [scoped, legacy] = logSpy.mock.calls.map(
      (call) => JSON.parse(call.arguments[0] as string) as Record<string, unknown>
    )
    assert.equal(scoped!.scope, 'db')
    assert.equal(legacy!.scope, 'legacy')
    assert.equal(scoped!.message, legacy!.message)
    assert.equal(scoped!.schema, legacy!.schema)
    assert.deepEqual(Object.keys(scoped!), Object.keys(legacy!))
  })

  test('a legacy Error argument becomes the error field, message and stack intact', () => {
    setWiki({ logFormat: 'json', logLevel: 'debug' })
    const primaryLogger = logger.init()
    const logSpy = mock.method(console, 'log', () => {})

    primaryLogger.warn(new Error('kaboom'), { reqId: 'req-1q' })

    const parsed = JSON.parse(logSpy.mock.calls[0]!.arguments[0] as string)
    assert.equal(parsed.scope, 'legacy')
    assert.equal(parsed.message, 'kaboom')
    assert.equal(parsed.reqId, 'req-1q')
    assert.match(parsed.error.stack, /Error: kaboom/)
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
    primaryLogger.info('from the parent')

    const [grandchild, child, parent] = parseLines(logSpy)
    assert.equal(grandchild!.engine, 'db')
    assert.equal(child!.scope, 'storage')
    assert.equal(child!.engine, undefined)
    // -> `legacy`, not absent: the parent call above is the pre-scope `(msg, context?)` shape, which
    //    the renderer files under its own sentinel. What matters here is that it is NOT `storage` —
    //    the child never wrote its scope or its fields back onto the logger it was built from.
    assert.equal(parent!.scope, 'legacy')
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
