import { styleText } from 'node:util'
import EventEmitter from 'node:events'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type IgnoredLogLevel = 'verbose' | 'silly'
// -> In JSON mode, merged into the payload as siblings of `message` (see the `WIKI.config.logFormat
//    === 'json'` branch below). Ignored entirely in text mode.
export type LogContext = Record<string, unknown>
export type LogFn = (msg: unknown, context?: LogContext) => void

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

    return primaryLogger
  }
}
