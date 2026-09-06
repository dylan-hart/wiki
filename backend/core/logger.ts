import { styleText } from 'node:util'
import EventEmitter from 'node:events'
import { LOG_SCOPES, type LogScope } from './logScopes.ts'

// -> The closed subsystem vocabulary every line is filed under, re-exported so it is reachable from
//    the logger itself, which is where a caller looks for it. `core/logScopes.ts` holds the one
//    declaration; this adds no second copy.
export { LOG_SCOPES, type LogScope } from './logScopes.ts'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type LogFormat = 'text' | 'json'

/**
 * A partial map of scope to the level that scope is emitted at, overriding the global `logLevel`
 * floor for that scope alone.
 *
 * Two things produce one: the `logScopes:` config key (a file setting, validated at boot) and the
 * `scopeOverrides` thunk `init()` is handed (a live setting, re-read on every line — which is what
 * lets the `sqlLog`/`authDebug` admin flags take effect on the next line with no restart). A scope
 * absent from both falls back to `logLevel`, so an empty map is exactly today's behaviour.
 *
 * An entry may LOWER a scope as well as raise it: `{ sql: 'error' }` silences a chatty subsystem
 * below the global floor. The global floor is not a floor in the arithmetic sense — it is the
 * default for a scope that says nothing.
 */
export type ScopeOverrides = Partial<Record<LogScope, LogLevel>>

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
 * One log record, built once per call, before either renderer runs.
 *
 * This is the wire shape the admin Live Log receives (`controllers/terminal.ts` sends
 * `JSON.stringify(frame)`) and the element type of the in-memory backlog, so the page filters and
 * colours by `level`/`scope` and expands `stack` itself rather than re-parsing a rendered line.
 * `renderText`/`renderJson` are pure functions of it, which is also what makes them unit-testable
 * without a logger instance.
 *
 * `fields` is already serialisation-safe: an `Error` anywhere in it has become
 * `{ name, message, stack }`, and a value `JSON.stringify` cannot represent (`undefined`, a
 * `bigint`, a symbol, a function, a circular object) has been stringified — see `toSerializable`.
 * `stack` repeats the top-level error's stack so the page has one place to look for it.
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
 * `LogFrame`s kept in memory, replayed to an admin terminal the moment it connects
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
 * `{ name, message, stack }` — what an `Error` becomes on a frame, in JSON output and on the wire
 * alike. An `Error` has no enumerable own properties, so `JSON.stringify`-ing one straight serializes
 * it as `{}`, losing the stack exactly where structured logging was requested (OpenProject #939).
 */
function serializeError(err: Error): { name: string; message: string; stack?: string } {
  return { name: err.name, message: err.message, stack: err.stack }
}

/**
 * One field value, made safe to `JSON.stringify` — because a frame is stringified twice over (once
 * onto stdout in JSON mode, once onto the admin terminal's socket) and a throw from either would
 * lose the very line the operator was trying to read.
 *
 * An `Error` anywhere in the fields gets the `{ name, message, stack }` treatment, not just the
 * top-level one. Everything `JSON.stringify` cannot represent — `undefined`, a `bigint`, a symbol, a
 * function, a circular object — is stringified rather than silently dropped: a field a call site
 * bothered to pass is worth showing even when it is only worth showing as text.
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
 * The one place a call becomes a frame — built before either renderer runs, so stdout, the backlog
 * and the admin terminal are all looking at the same record rather than at three near-copies.
 *
 * A top-level `Error` lands twice on purpose: in `fields.error` (where both renderers read it, and
 * where a JSON consumer expects it) and as `frame.stack` (where the Live Log page's expand
 * affordance reads it, without having to know the field convention). It is appended LAST in
 * `fields`, which is what keeps the text tail reading `…other fields… error=… in 528ms`.
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
    // -> `legacy` is not a member of the vocabulary — it is the sentinel an un-swept
    //    `(msg, context?)` call renders under, and OpenProject #2668 deletes that overload and this
    //    cast together. Narrow and deliberate, rather than widening the exported frame contract that
    //    the Live Log page reads.
    scope: record.scope as LogScope,
    message: record.message,
    fields,
    ...(record.error?.stack ? { stack: record.error.stack } : {})
  }
}

/** What an `error` field renders as in a text tail, whatever shape the field turned out to be. */
function errorTailValue(value: unknown): string {
  const message = (value as { message?: unknown } | null)?.message
  return typeof message === 'string' ? renderValue(message) : renderValue(value)
}

/**
 * `<ISO timestamp> <level padded 5> <scope padded 8>  <message>  <k=v …>`, with the stack — when the
 * level warrants one — on following lines indented two spaces.
 *
 * A pure function of the frame plus the one thing a frame cannot know: whether this run wants the
 * stack printed. No instance id: text mode is a person tailing one process, where the id is dead
 * weight. It stays on every JSON record for aggregators, and the admin terminal gets it in its
 * handshake frame.
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
  // -> Last in the tail, per the spec's own sample lines (`migrations=0 in 528ms`): the duration
  //    reads as a closing clause on the sentence, not as one field among the others.
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
 * `{ ...fields, timestamp, instance, level, scope, message }`.
 *
 * Fields are spread first so a caller can only ever ADD siblings: a field named `message` or `level`
 * loses the collision rather than corrupting the record. `error` rides in `fields` as an object
 * rather than as a stack pasted over `message` — the fix #939 needed at the time, now that there is
 * somewhere proper to put it, which lets `message` stay a sentence. `frame.stack` is deliberately
 * NOT repeated at the top level: in JSON it is already `error.stack`, and the frame's own copy
 * exists for the Live Log page's expand affordance, not for an aggregator.
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
  declare backlog: () => LogFrame[]
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

  /**
   * The live half of the per-scope threshold: consulted on EVERY line, ahead of the `logScopes:`
   * config map, so a scope it names is emitted at that level from the next line onwards with no
   * restart.
   *
   * A thunk rather than a value because that is the whole point — `index.ts` hands one reading
   * `WIKI.models.flags`, whose `sqlLog`/`authDebug` switches an administrator flips in the admin
   * area mid-run. It is injected rather than imported because `logger.init()` runs long before
   * `WIKI.models` exists, and the logger has no business importing a model in either case.
   *
   * Optional, and empty by default: the other five `init()` callers (`worker.ts`,
   * `tasks/promoteAdminRuntime.ts`, `mcp/bootstrap.ts`, `scripts/audit-site-scoped-rules.ts`,
   * `migration/bootstrap.ts`) have no flags model to read and inherit no overrides, which is what
   * they did before this existed too.
   */
  scopeOverrides?: () => ScopeOverrides
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
  const { logLevel, logFormat, logScopes } = WIKI.config
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
 * Refuses a `logScopes:` map this logger cannot honour — same one-line-refusal-then-exit shape as
 * `logLevel`/`logFormat` above, and for the same reason: a typo'd scope name is a scope that is
 * never consulted, so an operator who mistyped one would see nothing traced and be told nothing
 * about why.
 *
 * `undefined` and `null` are the default (`base.yml` declares the key as an explicit null, so that
 * `core/config.ts#warnUnknownConfigKeys` does not descend into a free-form map and flag every entry
 * in it as unknown). Anything else must be a plain object of `LogScope` to `LogLevel`.
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

    /*
      The threshold a line is measured against, resolved PER CALL rather than baked in here
      (OpenProject #2663). Three sources, most specific first: the live override thunk (the
      `sqlLog`/`authDebug` admin flags, which is why this cannot be a value), then the `logScopes:`
      config map, then the global `logLevel` floor.

      `legacy` — the sentinel an un-swept `(msg, context?)` call renders under — is not a member of
      the vocabulary, so it matches neither map and falls through to `logLevel`, which is exactly
      what it did before per-scope thresholds existed.
    */
    const effectiveLevel = (scope: string): LogLevel =>
      scopeOverrides()[scope as LogScope] ??
      (WIKI.config.logScopes as ScopeOverrides | null | undefined)?.[scope as LogScope] ??
      WIKI.config.logLevel

    primaryLogger.ws = new EventEmitter()
    // -> One listener per connected admin terminal, so the default cap of 10 is a leak warning rather
    //    than a limit worth respecting
    primaryLogger.ws.setMaxListeners(0)
    primaryLogger.backlog = () => [...backlog]

    /*
      A listener on EVERY level, with the threshold applied inside it (OpenProject #2663).

      This used to be structural: the loop stopped attaching listeners once it passed `logLevel`, so
      a `debug` call at `logLevel: info` reached no listener at all. Per-scope thresholds cannot work
      that way — which threshold applies is not known until `normalizeCall` has read the scope off
      the arguments — so the decision moves one line inside, immediately after the call is
      normalized and before any frame is built. With `logScopes` unset and no override thunk, this
      is behaviour-identical to the loop it replaced.
    */
    LEVELS.forEach((lvl) => {
      primaryLogger[lvl] = ((a: unknown, b?: unknown, c?: LogFields) => {
        primaryLogger.emit(lvl, a, b, c)
      }) as LogFn

      primaryLogger.on(lvl, (a: unknown, b?: unknown, c?: LogFields) => {
        const record = normalizeCall(a, b, c)
        if (LEVELS.indexOf(lvl) > LEVELS.indexOf(effectiveLevel(record.scope))) {
          return
        }

        const frame = buildFrame(record, lvl, new Date().toISOString(), WIKI.INSTANCE_ID)
        // -> A stack is noise on a warning an operator has already decided to live with, and the
        //    whole point of the record on an error. `warn` gets one only when the operator has
        //    asked for everything. Deliberately the GLOBAL level, not this scope's: "show me
        //    everything" is a property of the run, and reading it per scope would also strip the
        //    stack off a warning in a scope an operator had quietened for unrelated reasons.
        const withStack = lvl === 'error' || (lvl === 'warn' && WIKI.config.logLevel === 'debug')

        console.log(
          WIKI.config.logFormat === 'json' ? renderJson(frame) : renderText(frame, { withStack })
        )

        /*
          The backlog and the socket carry the FRAME, not the rendered line (OpenProject #2679):
          the admin Live Log filters by level and scope and expands a stack on demand, none of
          which it can do against a string it would have to parse back apart — and doing so would
          also mean shipping this process's stdout format and its ANSI escapes to a browser that
          has its own opinion about both.

          A scope raised by `logScopes` or by a flag therefore reaches the admin terminal as well as
          stdout, which is the point: #2660 raised `BACKLOG_SIZE` to 500 so that turning `sqlLog` on
          for one page load no longer evicts the whole window.
        */
        backlog.push(frame)
        if (backlog.length > BACKLOG_SIZE) {
          backlog.shift()
        }
        primaryLogger.ws.emit('log', frame)
      })
    })

    // -> Assigned after the level loop above, so a child forwards to the *final* level methods and
    //    is therefore gated by `effectiveLevel` exactly as a direct call is.
    primaryLogger.scope = (name: LogScope, fields?: LogFields) =>
      createScopedLogger(primaryLogger, name, fields ?? {})

    return primaryLogger
  }
}
