/* eslint-disable no-console -- this file IS the sink: `console` here is where every log line is actually written. */
import { styleText } from 'node:util'
import EventEmitter from 'node:events'
import { LOG_SCOPES, type LogScope } from './logScopes.ts'

export { LOG_SCOPES, type LogScope } from './logScopes.ts'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type LogFormat = 'text' | 'json'

/**
 * An entry may lower a scope as well as raise it (`{ sql: 'error' }`): `logLevel` is not a floor,
 * only the default for a scope no entry names.
 */
export type ScopeOverrides = Partial<Record<LogScope, LogLevel>>

/**
 * Two keys are rendered rather than printed verbatim: `error` (an `Error`) becomes `error="…"`
 * plus, where the level warrants it, the stack; `ms` (a number) becomes a humanised `in 12ms` /
 * `in 3.7s`.
 */
export type LogFields = Record<string, unknown>

/**
 * The wire shape the admin Live Log receives (`controllers/terminal.ts` sends
 * `JSON.stringify(frame)`) and the backlog's element type. `fields` is already serialisation-safe
 * (see `toSerializable`); `stack` repeats the top-level error's stack so the page has one place to
 * look for it.
 */
export interface LogFrame {
  timestamp: string
  instance: string
  level: LogLevel
  scope: LogScope
  message: string
  fields: LogFields
  stack?: string
}

/**
 * The only call shape, deliberately: with no second overload, a call missing its scope is a type
 * error. So is an `Error` as the `message` — it goes in `fields.error`, where the renderer can put
 * the situation and the stack in one record.
 */
export type LogFn = (scope: LogScope, message: string, fields?: LogFields) => void

export type ScopedLogFn = (message: string, fields?: LogFields) => void

/**
 * A logger bound to one scope and a standing set of fields. `scope()` on a child yields a further
 * child: the new name replaces the old one, the fields merge, the newer winning.
 */
export interface ScopedLogger {
  error: ScopedLogFn
  warn: ScopedLogFn
  info: ScopedLogFn
  debug: ScopedLogFn
  scope: (name: LogScope, fields?: LogFields) => ScopedLogger
}

/**
 * Frames kept in memory and replayed to an admin terminal when it connects
 * (`controllers/terminal.ts`). Sized so that turning `sqlLog` on for one page load does not evict
 * the whole window.
 */
const BACKLOG_SIZE = 500

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug']
const LOG_FORMATS: LogFormat[] = ['text', 'json']

/** `info` is deliberately uncoloured and `debug` dim, so a `warn` stands out in a long tail. */
const LEVELCOLORS: Record<LogLevel, 'red' | 'yellow' | 'dim' | null> = {
  error: 'red',
  warn: 'yellow',
  info: null,
  debug: 'dim'
}

const LEVEL_WIDTH = 5
const SCOPE_WIDTH = 8

interface LogRecord {
  scope: LogScope
  message: string
  fields: LogFields
  error?: Error
}

function isError(value: unknown): value is Error {
  return value instanceof Error
}

function normalizeCall(scope: LogScope, message: string, fields?: LogFields): LogRecord {
  const { error: fieldError, ...rest } = fields ?? {}
  let error: Error | undefined
  if (isError(fieldError)) {
    error = fieldError
  } else if (fieldError !== undefined) {
    // -> Not an `Error`: no name or stack to lift out, so it stays an ordinary field.
    rest.error = fieldError
  }

  return { scope, message, fields: rest, error }
}

export function humanizeDuration(ms: number): string {
  return ms < 1000 ? `in ${ms}ms` : `in ${(ms / 1000).toFixed(1)}s`
}

/** Quoted when it contains whitespace or a quote, so the tail survives a split on whitespace. */
function renderValue(value: unknown): string {
  const text =
    value === null || value === undefined
      ? String(value)
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  return /[\s"]/.test(text) ? JSON.stringify(text) : text
}

/** An `Error` has no enumerable own properties, so a bare `JSON.stringify` of one yields `{}`. */
function serializeError(err: Error): { name: string; message: string; stack?: string } {
  return { name: err.name, message: err.message, stack: err.stack }
}

/**
 * A frame is `JSON.stringify`-ed onto stdout in JSON mode and onto the admin terminal's socket, and
 * a throw from either would lose the line. What JSON cannot represent (`undefined`, a `bigint`, a
 * symbol, a function, a circular object) is stringified rather than silently dropped.
 */
function toSerializable(value: unknown): unknown {
  if (value === null) {
    return null
  }
  if (isError(value)) {
    return serializeError(value)
  }
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') {
    return value
  }
  // -> `NaN` and the infinities stringify as `null`, which reads as "no value" rather than as the
  //    arithmetic accident it usually is
  if (kind === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }
  if (kind === 'object') {
    try {
      JSON.stringify(value)
      return value
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * `error` is appended last in `fields`, which is what keeps the text tail reading
 * `…other fields… error=… in 528ms`.
 */
function buildFrame(
  record: LogRecord,
  level: LogLevel,
  timestamp: string,
  instance: string
): LogFrame {
  const fields: LogFields = {}
  for (const [key, value] of Object.entries(record.fields)) {
    fields[key] = toSerializable(value)
  }
  if (record.error) {
    fields.error = serializeError(record.error)
  }
  return {
    timestamp,
    instance,
    level,
    scope: record.scope,
    message: record.message,
    fields,
    ...(record.error?.stack ? { stack: record.error.stack } : {})
  }
}

function errorTailValue(value: unknown): string {
  const message = (value as { message?: unknown } | null)?.message
  return typeof message === 'string' ? renderValue(message) : renderValue(value)
}

/**
 * `<ISO timestamp> <level> <scope>  <message>  <k=v …>`, level and scope padded so the message
 * starts at a fixed column. No instance id: text mode is a person tailing one process. It stays on
 * every JSON record, and the admin terminal gets it in its handshake frame.
 */
export function renderText(
  frame: LogFrame,
  { withStack = false }: { withStack?: boolean } = {}
): string {
  const lvl = frame.level
  const color = LEVELCOLORS[lvl]
  const parts: string[] = []
  for (const [key, value] of Object.entries(frame.fields)) {
    if (key === 'ms' && typeof value === 'number') {
      continue
    }
    parts.push(
      `${styleText('dim', key)}=${key === 'error' ? errorTailValue(value) : renderValue(value)}`
    )
  }
  // -> Last in the tail: the duration reads as a closing clause, not as one field among the others.
  if (typeof frame.fields.ms === 'number') {
    parts.push(styleText('dim', humanizeDuration(frame.fields.ms)))
  }

  const message = color ? styleText(color, frame.message) : frame.message
  const head = [
    styleText('dim', frame.timestamp),
    color ? styleText(color, lvl.padEnd(LEVEL_WIDTH)) : lvl.padEnd(LEVEL_WIDTH),
    styleText('dim', frame.scope.padEnd(SCOPE_WIDTH))
  ].join(' ')

  let line = `${head}  ${message}`
  if (parts.length > 0) {
    line += `  ${parts.join(' ')}`
  }
  if (withStack && frame.stack) {
    line += `\n${frame.stack
      .split('\n')
      .map((stackLine) => `  ${stackLine}`)
      .join('\n')}`
  }
  return line
}

/**
 * Fields are spread first so a caller can only ever add siblings: a field named `message` or
 * `level` loses the collision. `frame.stack` is deliberately not repeated — in JSON it is already
 * `error.stack`.
 */
export function renderJson(frame: LogFrame): string {
  return JSON.stringify({
    ...frame.fields,
    timestamp: frame.timestamp,
    instance: frame.instance,
    level: frame.level,
    scope: frame.scope,
    message: frame.message
  })
}

/**
 * Forwards to the parent's level methods rather than emitting on its own, so a child inherits the
 * threshold, the backlog and the terminal socket.
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
  // -> Assigned in init(). `declare` keeps these type-only, so no class field is emitted.
  declare ws: EventEmitter
  declare backlog: () => LogFrame[]
  declare error: LogFn
  declare warn: LogFn
  declare info: LogFn
  declare debug: LogFn
  declare scope: (name: LogScope, fields?: LogFields) => ScopedLogger
}

export interface LoggerInitOptions {
  /** Injected so a test can assert a config refusal without killing the test runner. */
  exit?: (code: number) => void

  /**
   * Consulted on every line, ahead of the `logScopes:` config map — a thunk so that an admin flag
   * (`sqlLog`, `authDebug`) takes effect on the next line with no restart. Injected rather than
   * imported because `logger.init()` runs long before `CARDINAL.models` exists.
   */
  scopeOverrides?: () => ScopeOverrides
}

/**
 * Refuses a value this logger cannot honour -- a typo, a wrong case, the 2.x `verbose`/`silly` --
 * rather than quietly doing something else with it: anything but `json` would otherwise take the
 * text branch, so `jsno` would look like it worked. `console.error` because there is no logger to
 * report through yet.
 */
function assertValidLogConfig(exit: (code: number) => void): void {
  const { logLevel, logFormat, logScopes } = CARDINAL.config
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
  assertValidLogScopes(logScopes, exit)
}

/**
 * A typo'd scope name is never consulted, so an operator who mistyped one would see nothing traced
 * and be told nothing about why. `null` is the default: `base.yml` declares the key as an explicit
 * null so that `core/config.ts#warnUnknownConfigKeys` does not descend into the map and flag every
 * entry in it as unknown.
 */
function assertValidLogScopes(logScopes: unknown, exit: (code: number) => void): void {
  if (logScopes === undefined || logScopes === null) {
    return
  }
  if (typeof logScopes !== 'object' || Array.isArray(logScopes)) {
    console.error(
      styleText(
        ['red', 'bold'],
        `>>> Invalid \`logScopes\` value ${JSON.stringify(logScopes)} in config.yml — must be a map of scope to level.`
      )
    )
    exit(1)
    return
  }
  for (const [scope, level] of Object.entries(logScopes as Record<string, unknown>)) {
    if (!(LOG_SCOPES as readonly string[]).includes(scope)) {
      console.error(
        styleText(
          ['red', 'bold'],
          `>>> Unknown \`logScopes\` scope ${JSON.stringify(scope)} in config.yml — must be one of: ${LOG_SCOPES.join(', ')}.`
        )
      )
      exit(1)
    } else if (!LEVELS.includes(level as LogLevel)) {
      console.error(
        styleText(
          ['red', 'bold'],
          `>>> Invalid \`logScopes.${scope}\` value ${JSON.stringify(level)} in config.yml — must be one of: ${LEVELS.join(', ')}.`
        )
      )
      exit(1)
    }
  }
}

export default {
  loggers: {},
  init({
    exit = (code: number) => process.exit(code),
    scopeOverrides = () => ({})
  }: LoggerInitOptions = {}): Logger {
    assertValidLogConfig(exit)

    const primaryLogger = new Logger()

    const backlog: LogFrame[] = []

    // -> Resolved per call rather than baked in here, because the override thunk is live. Most
    //    specific source first.
    const effectiveLevel = (scope: string): LogLevel =>
      scopeOverrides()[scope as LogScope] ??
      (CARDINAL.config.logScopes as ScopeOverrides | null | undefined)?.[scope as LogScope] ??
      CARDINAL.config.logLevel

    primaryLogger.ws = new EventEmitter()
    // -> One listener per connected admin terminal, so the default cap of 10 is a leak warning rather
    //    than a limit worth respecting
    primaryLogger.ws.setMaxListeners(0)
    primaryLogger.backlog = () => [...backlog]

    // -> A listener on every level, with the threshold applied inside it: which threshold applies
    //    is not known until the call's own scope is in hand.
    LEVELS.forEach((lvl) => {
      primaryLogger[lvl] = ((scope: LogScope, message: string, fields?: LogFields) => {
        primaryLogger.emit(lvl, scope, message, fields)
      }) as LogFn

      primaryLogger.on(lvl, (scope: LogScope, message: string, fields?: LogFields) => {
        const record = normalizeCall(scope, message, fields)
        if (LEVELS.indexOf(lvl) > LEVELS.indexOf(effectiveLevel(record.scope))) {
          return
        }

        const frame = buildFrame(record, lvl, new Date().toISOString(), CARDINAL.INSTANCE_ID)
        // -> A stack is noise on a warning and the point of the record on an error, so `warn` gets
        //    one only at `logLevel: debug`. Deliberately the GLOBAL level, not this scope's: per
        //    scope, a warning in a scope quietened for unrelated reasons would lose its stack.
        const withStack =
          lvl === 'error' || (lvl === 'warn' && CARDINAL.config.logLevel === 'debug')

        console.log(
          CARDINAL.config.logFormat === 'json'
            ? renderJson(frame)
            : renderText(frame, { withStack })
        )

        // -> The backlog and the socket carry the frame, not the rendered line: the admin Live Log
        //    filters by level and scope and expands a stack itself, and must not be sent this
        //    process's stdout format or its ANSI escapes.
        backlog.push(frame)
        if (backlog.length > BACKLOG_SIZE) {
          backlog.shift()
        }
        primaryLogger.ws.emit('log', frame)
      })
    })

    primaryLogger.scope = (name: LogScope, fields?: LogFields) =>
      createScopedLogger(primaryLogger, name, fields ?? {})

    return primaryLogger
  }
}
