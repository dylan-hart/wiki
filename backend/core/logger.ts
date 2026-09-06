import { styleText } from 'node:util'
import EventEmitter from 'node:events'
import type { LogScope } from './logScopes.ts'

// -> The closed subsystem vocabulary every line is filed under, re-exported so it is reachable from
//    the logger itself, which is where a caller looks for it. `core/logScopes.ts` holds the one
//    declaration; this adds no second copy.
export { LOG_SCOPES, type LogScope } from './logScopes.ts'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type LogFormat = 'text' | 'json'

/**
 * The `key=value` tail of a text line, and the sibling fields of a JSON record — one call site,
 * both outputs.
 *
 * Two keys are rendered rather than printed verbatim: `error` (an `Error`) becomes `error="…"` plus,
 * where the level warrants it, the stack; `ms` (a duration in milliseconds) becomes a humanised
 * `in 12ms` / `in 3.7s`. Everything else is a plain `key=value`.
 */
export type LogFields = Record<string, unknown>

/**
 * Both call shapes a level accepts for the duration of Phase 2.
 *
 * `(scope, message, fields?)` is the real one. The legacy `(msg, context?)` overload is what the
 * remaining un-swept call sites still use; it renders under the sentinel scope `legacy`, so a grep
 * over the output says how much of the sweep is left. Phase 2's last task (OpenProject #2668)
 * deletes the overload and the branch behind it together.
 *
 * A bare `Error` as the `message` of the new shape is a type error, on purpose: an error goes in
 * `fields.error`, where the renderer can put the situation and the stack in ONE record.
 */
export type LogFn = {
  (scope: LogScope, message: string, fields?: LogFields): void
  (msg: unknown, context?: LogFields): void
}

/**
 * A level method on a scoped child. The scope is already fixed, so what is left is the same
 * `(message, fields?)` tail the parent's own new-shape call takes — and only that: the legacy
 * `(msg, context?)` overload is a Phase 2 bridge for un-swept call sites, and a child is new API
 * with nothing to bridge.
 */
export type ScopedLogFn = (message: string, fields?: LogFields) => void

/**
 * A logger bound to one scope and a constant set of fields, for a file that logs a lot from one
 * subsystem: `modules/storage/*` with its `target`/`module`, `modules/search/*` with its `engine`,
 * `core/collab.ts` with its `page`. Every line it emits carries them, so the call site writes only
 * what is new about that line.
 *
 * `scope()` on a child yields a further child: the new name replaces the old one (a line is filed
 * under exactly one scope) while the fields merge, the newer winning.
 */
export interface ScopedLogger {
  error: ScopedLogFn
  warn: ScopedLogFn
  info: ScopedLogFn
  debug: ScopedLogFn
  scope: (name: LogScope, fields?: LogFields) => ScopedLogger
}

/**
 * Formatted lines kept in memory, replayed to an admin terminal the moment it connects
 * (`controllers/terminal.ts`). Enough to see how the instance got to where it is, not a log file.
 *
 * 500 rather than 100: with the heartbeat lines demoted to `debug`, a quiet instance adds a handful
 * of lines an hour, so this is hours of real history instead of minutes of ticks.
 */
const BACKLOG_SIZE = 500

/**
 * The scope a legacy `(msg, context?)` call is filed under. Deliberately NOT a member of the
 * `LOG_SCOPES` vocabulary: it is a renderer-internal sentinel, so passing `'legacy'` as a real first
 * argument stays something the Phase 2 structural test can refuse.
 */
const LEGACY_SCOPE = 'legacy'

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug']
const LOG_FORMATS: LogFormat[] = ['text', 'json']

/**
 * Red / yellow / plain / dim. The level IS the status, so `info` needs no colour of its own and
 * `debug` recedes — the point being that a `warn` is still visible after a week of tailing.
 */
const LEVELCOLORS: Record<LogLevel, 'red' | 'yellow' | 'dim' | null> = {
  error: 'red',
  warn: 'yellow',
  info: null,
  debug: 'dim'
}

const LEVEL_WIDTH = 5
const SCOPE_WIDTH = 8

/**
 * One call, normalized: whichever shape the caller used, the renderers see the same three things.
 *
 * The discriminator is `typeof b === 'string'` on top of `typeof a === 'string'` — the new shape's
 * second argument is always a message, the legacy shape's is always a context object or absent, and
 * a grep over `backend/` confirms no legacy call site passes a string there.
 */
interface LogRecord {
  scope: string
  message: string
  fields: LogFields
  error?: Error
}

function isError(value: unknown): value is Error {
  return value instanceof Error
}

function normalizeCall(a: unknown, b?: unknown, c?: LogFields): LogRecord {
  const isNewShape = typeof a === 'string' && typeof b === 'string'
  const scope = isNewShape ? a : LEGACY_SCOPE
  const rawFields = (isNewShape ? c : (b as LogFields | undefined)) ?? {}

  // -> The legacy shape's message may be anything, `Error` included, and the stack-as-message trick
  //    (OpenProject #939) is what kept that call readable before there was an `error` field. Route
  //    it into `fields.error` instead, so both shapes reach the renderers with the situation in
  //    `message` and the error in one place.
  let message: string
  let error: Error | undefined
  if (isNewShape) {
    message = b as string
  } else if (isError(a)) {
    message = a.message
    error = a
  } else {
    message = String(a)
  }

  const { error: fieldError, ...rest } = rawFields
  if (isError(fieldError)) {
    error = fieldError
  } else if (fieldError !== undefined) {
    // -> Not an `Error`, so there is no name or stack to lift out; keep it as an ordinary field
    //    rather than inventing one.
    rest.error = fieldError
  }

  return { scope, message, fields: rest, error }
}

/**
 * `528` -> `in 528ms`, `3900` -> `in 3.9s`. Sub-second durations stay in milliseconds because that
 * is the resolution the operator cares about there; anything longer reads better as seconds.
 */
export function humanizeDuration(ms: number): string {
  return ms < 1000 ? `in ${ms}ms` : `in ${(ms / 1000).toFixed(1)}s`
}

/**
 * A tail value: quoted when it contains a space (or a quote of its own), bare otherwise, so
 * `error="fetching locale metadata failed: 404"` survives being split on whitespace.
 */
function renderValue(value: unknown): string {
  const text =
    value === null || value === undefined
      ? String(value)
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  return /[\s"]/.test(text) ? JSON.stringify(text) : text
}

/**
 * `<ISO timestamp> <level padded 5> <scope padded 8>  <message>  <k=v …>`, with the stack — when the
 * level warrants one — on following lines indented two spaces.
 *
 * No instance id: text mode is a person tailing one process, where the id is dead weight. It stays
 * on every JSON record for aggregators, and the admin terminal gets it in its handshake frame.
 */
function renderText(
  record: LogRecord,
  lvl: LogLevel,
  timestamp: string,
  { withStack }: { withStack: boolean }
): string {
  const color = LEVELCOLORS[lvl]
  const parts: string[] = []
  for (const [key, value] of Object.entries(record.fields)) {
    if (key === 'ms' && typeof value === 'number') {
      continue
    }
    parts.push(`${styleText('dim', key)}=${renderValue(value)}`)
  }
  if (record.error) {
    parts.push(`${styleText('dim', 'error')}=${renderValue(record.error.message)}`)
  }
  // -> Last in the tail, per the spec's own sample lines (`migrations=0 in 528ms`): the duration
  //    reads as a closing clause on the sentence, not as one field among the others.
  if (typeof record.fields.ms === 'number') {
    parts.push(styleText('dim', humanizeDuration(record.fields.ms)))
  }

  const message = color ? styleText(color, record.message) : record.message
  const head = [
    styleText('dim', timestamp),
    color ? styleText(color, lvl.padEnd(LEVEL_WIDTH)) : lvl.padEnd(LEVEL_WIDTH),
    styleText('dim', record.scope.padEnd(SCOPE_WIDTH))
  ].join(' ')

  let line = `${head}  ${message}`
  if (parts.length > 0) {
    line += `  ${parts.join(' ')}`
  }
  if (withStack && record.error?.stack) {
    line += `\n${record.error.stack
      .split('\n')
      .map((stackLine) => `  ${stackLine}`)
      .join('\n')}`
  }
  return line
}

/**
 * `{ ...fields, timestamp, instance, level, scope, message, error? }`.
 *
 * Fields are spread first so a caller can only ever ADD siblings: a field named `message` or `level`
 * loses the collision rather than corrupting the record. `error` is an object rather than a
 * stack pasted over `message` — the fix #939 needed at the time, now that there is somewhere proper
 * to put it, which lets `message` stay a sentence.
 */
function renderJson(record: LogRecord, lvl: LogLevel, timestamp: string): string {
  return JSON.stringify({
    ...record.fields,
    timestamp,
    instance: WIKI.INSTANCE_ID,
    level: lvl,
    scope: record.scope,
    message: record.message,
    ...(record.error
      ? {
          error: {
            name: record.error.name,
            message: record.error.message,
            stack: record.error.stack
          }
        }
      : {})
  })
}

/**
 * Build a child bound to `name` and `fields`.
 *
 * It forwards to the parent's own level methods rather than emitting on its own, so a child inherits
 * the level gating, the backlog and the terminal socket for free and there is still exactly one
 * renderer. The scope rides the first argument, exactly as a direct new-shape call spells it, so a
 * scoped line is indistinguishable from an unscoped one once it reaches `normalizeCall`. Field
 * precedence is fixed here and nowhere else: the child's standing fields, then the call's own — so a
 * call may override a field it inherited, and a call that says nothing still carries everything the
 * child was built with.
 */
function createScopedLogger(
  emitters: Record<LogLevel, LogFn>,
  name: LogScope,
  fields: LogFields
): ScopedLogger {
  const at =
    (lvl: LogLevel): ScopedLogFn =>
    (message: string, callFields?: LogFields) => {
      emitters[lvl](name, message, { ...fields, ...callFields })
    }

  return {
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    scope: (childName: LogScope, childFields?: LogFields) =>
      createScopedLogger(emitters, childName, { ...fields, ...childFields })
  }
}

class Logger extends EventEmitter {
  // -> Assigned dynamically in init(). `declare` keeps these type-only so that no class field is
  //    emitted, leaving the runtime shape of the instance untouched.
  declare ws: EventEmitter
  declare backlog: () => string[]
  declare error: LogFn
  declare warn: LogFn
  declare info: LogFn
  declare debug: LogFn
  declare scope: (name: LogScope, fields?: LogFields) => ScopedLogger
}

export interface LoggerInitOptions {
  /**
   * How a rejected config value ends the process. Injected so a test can assert the refusal without
   * killing the test runner; production hands it `process.exit`, which never returns.
   */
  exit?: (code: number) => void
}

/**
 * Refuses a `logLevel` or `logFormat` this logger cannot honour, rather than quietly doing something
 * else with it.
 *
 * The threshold below is picked by walking `LEVELS` until the configured name matches, so a value
 * that never matches -- a typo (`Info`, `warning`, `trace`), an empty string, or the 2.x names
 * (`verbose`, `silly`) this logger has never implemented -- used to leave every listener attached and
 * log at `debug`, with nothing said about the config having been ignored. `logFormat` had the same
 * shape of hole: anything but `json` silently took the text branch, so `jsno` looked like it worked.
 *
 * `console.error`, not `WIKI.logger.error`: this decides how `WIKI.logger` is built, so there is no
 * logger to report through yet -- the same exception `core/config.ts#warnUnknownConfigKeys`
 * documents for itself. One line per rejected value, naming the value and the valid set, then exit.
 */
function assertValidLogConfig(exit: (code: number) => void): void {
  const { logLevel, logFormat } = WIKI.config
  if (!LEVELS.includes(logLevel)) {
    console.error(
      styleText(
        ['red', 'bold'],
        `>>> Invalid \`logLevel\` value ${JSON.stringify(logLevel)} in config.yml — must be one of: ${LEVELS.join(', ')}.`
      )
    )
    exit(1)
  }
  if (!LOG_FORMATS.includes(logFormat)) {
    console.error(
      styleText(
        ['red', 'bold'],
        `>>> Invalid \`logFormat\` value ${JSON.stringify(logFormat)} in config.yml — must be one of: ${LOG_FORMATS.join(', ')}.`
      )
    )
    exit(1)
  }
}

export default {
  loggers: {},
  init({ exit = (code: number) => process.exit(code) }: LoggerInitOptions = {}): Logger {
    assertValidLogConfig(exit)

    const primaryLogger = new Logger()

    let ignoreNextLevels = false
    const backlog: string[] = []

    primaryLogger.ws = new EventEmitter()
    // -> One listener per connected admin terminal, so the default cap of 10 is a leak warning rather
    //    than a limit worth respecting
    primaryLogger.ws.setMaxListeners(0)
    primaryLogger.backlog = () => [...backlog]

    LEVELS.forEach((lvl) => {
      primaryLogger[lvl] = ((a: unknown, b?: unknown, c?: LogFields) => {
        primaryLogger.emit(lvl, a, b, c)
      }) as LogFn

      if (!ignoreNextLevels) {
        primaryLogger.on(lvl, (a: unknown, b?: unknown, c?: LogFields) => {
          const record = normalizeCall(a, b, c)
          const timestamp = new Date().toISOString()
          // -> A stack is noise on a warning an operator has already decided to live with, and the
          //    whole point of the record on an error. `warn` gets one only when the operator has
          //    asked for everything.
          const withStack = lvl === 'error' || (lvl === 'warn' && WIKI.config.logLevel === 'debug')
          const formatted =
            WIKI.config.logFormat === 'json'
              ? renderJson(record, lvl, timestamp)
              : renderText(record, lvl, timestamp, { withStack })

          console.log(formatted)

          backlog.push(formatted)
          if (backlog.length > BACKLOG_SIZE) {
            backlog.shift()
          }
          primaryLogger.ws.emit('log', formatted)
        })
      }
      if (lvl === WIKI.config.logLevel) {
        ignoreNextLevels = true
      }
    })

    // -> Assigned after the level loop above, so a child forwards to the *final* level methods and
    //    is therefore gated by `logLevel` exactly as a direct call is: a level past the configured
    //    threshold still emits, but has no listener rendering it.
    primaryLogger.scope = (name: LogScope, fields?: LogFields) =>
      createScopedLogger(primaryLogger, name, fields ?? {})

    return primaryLogger
  }
}
