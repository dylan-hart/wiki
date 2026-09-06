import { styleText } from 'node:util'
import EventEmitter from 'node:events'
import type { LogScope } from './logScopes.ts'

// -> Re-exported so the vocabulary is reachable from the logger itself, which is where a caller
//    looks for it. `core/logScopes.ts` holds the one declaration; this adds no second copy.
export { LOG_SCOPES, type LogScope } from './logScopes.ts'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type IgnoredLogLevel = 'verbose' | 'silly'
// -> In JSON mode, merged into the payload as siblings of `message` (see the `WIKI.config.logFormat
//    === 'json'` branch below). Ignored entirely in text mode.
export type LogContext = Record<string, unknown>
export type LogFn = (msg: unknown, context?: LogContext) => void

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
  error: LogFn
  warn: LogFn
  info: LogFn
  debug: LogFn
  scope: (name: LogScope, fields?: LogContext) => ScopedLogger
}

/**
 * Formatted lines kept in memory, replayed to an admin terminal the moment it connects
 * (`controllers/terminal.ts`). Enough to see how the instance got to where it is, not a log file.
 */
const BACKLOG_SIZE = 100

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug']
const LEVELSIGNORED: IgnoredLogLevel[] = ['verbose', 'silly']
const LEVELCOLORS: Record<LogLevel, 'red' | 'yellow' | 'green' | 'cyan'> = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'cyan'
}

/**
 * Build a child bound to `name` and `fields`.
 *
 * It forwards to the parent's own level methods rather than emitting on its own, so a child inherits
 * the level gating, the backlog and the terminal socket for free and there is still exactly one
 * renderer. Field precedence is fixed here and nowhere else: the scope first, then the child's
 * standing fields, then the call's own — so a call may override a field it inherited, and a call
 * that says nothing still carries everything the child was built with.
 */
function createScopedLogger(
  emitters: Record<LogLevel, LogFn>,
  name: LogScope,
  fields: LogContext
): ScopedLogger {
  const at =
    (lvl: LogLevel): LogFn =>
    (msg: unknown, context?: LogContext) => {
      emitters[lvl](msg, { scope: name, ...fields, ...context })
    }

  return {
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    scope: (childName: LogScope, childFields?: LogContext) =>
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
  declare verbose: LogFn
  declare silly: LogFn
  declare scope: (name: LogScope, fields?: LogContext) => ScopedLogger
}

export default {
  loggers: {},
  init(): Logger {
    const primaryLogger = new Logger()

    let ignoreNextLevels = false
    const backlog: string[] = []

    primaryLogger.ws = new EventEmitter()
    // -> One listener per connected admin terminal, so the default cap of 10 is a leak warning rather
    //    than a limit worth respecting
    primaryLogger.ws.setMaxListeners(0)
    primaryLogger.backlog = () => [...backlog]

    LEVELS.forEach((lvl) => {
      primaryLogger[lvl] = (msg: unknown, context?: LogContext) => {
        primaryLogger.emit(lvl, msg, context)
      }

      if (!ignoreNextLevels) {
        primaryLogger.on(lvl, (msg: unknown, context?: LogContext) => {
          let formatted = ''
          // -> Normalized before the format branch below: `Error` has no enumerable own properties, so
          //    `JSON.stringify`-ing one straight (the JSON branch used to) serialized it as `{}`,
          //    losing the stack and message exactly where structured logging was requested. Both
          //    branches need the same stand-in, since `logger.warn(err)` / `logger.error(err)` is the
          //    dominant call pattern across the codebase (OpenProject #939).
          if (msg instanceof Error) {
            msg = msg.stack
          }
          if (WIKI.config.logFormat === 'json') {
            formatted = JSON.stringify({
              // -> Spread first so `context` can only ever add sibling fields, never override the four
              //    fixed ones below — a context key named e.g. `message` or `level` loses the collision
              //    rather than corrupting the record. A context-free call spreads nothing, leaving this
              //    byte-identical to the pre-context-support payload.
              ...context,
              timestamp: new Date().toISOString(),
              instance: WIKI.INSTANCE_ID,
              level: lvl,
              message: msg
            })
          } else {
            formatted = `${new Date().toISOString()} ${styleText('dim', '[' + WIKI.INSTANCE_ID + ']')} ${styleText([LEVELCOLORS[lvl], 'bold'], lvl)}: ${msg}`
          }

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

    LEVELSIGNORED.forEach((lvl) => {
      primaryLogger[lvl] = () => {}
    })

    // -> Assigned after the level loop above, so a child forwards to the *final* level methods and
    //    is therefore gated by `logLevel` exactly as a direct call is: a level past the configured
    //    threshold still emits, but has no listener rendering it.
    primaryLogger.scope = (name: LogScope, fields?: LogContext) =>
      createScopedLogger(primaryLogger, name, fields ?? {})

    return primaryLogger
  }
}
