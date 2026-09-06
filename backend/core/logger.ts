import { styleText } from 'node:util'
import EventEmitter from 'node:events'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type LogFormat = 'default' | 'json'
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
const LOG_FORMATS: LogFormat[] = ['default', 'json']
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

    return primaryLogger
  }
}
