import type { LogFn } from './logger.ts'

/**
 * The subset of `Logger` these guards actually call — kept narrow so a test can pass a bare
 * `{ error: mock.fn() }` instead of a real `WIKI.logger`.
 */
export interface BootLogger {
  error: LogFn
}

/**
 * Runs `phase`, and on rejection logs through `logger.error` and exits deliberately rather than
 * letting the rejection propagate unhandled and take the process down with a bare stack — the same
 * shape `preBoot()` already uses for its own failure at `index.ts:197-203`. Nothing before this
 * existed for `postBoot()` (`index.ts:944-946`), whose failure — a storage module whose remote is
 * unreachable during `syncAllSites()`, a search engine failing `init()` — used to crash the process
 * silently, and (until sibling task #2058's readiness-ordering fix lands) one that had already
 * reported itself ready and taken traffic.
 *
 * `exit` defaults to `process.exit` but is injectable so a test can assert the call without actually
 * terminating the test runner's process.
 */
export async function runBootPhaseOrExit(
  phase: () => Promise<void>,
  label: string,
  logger: BootLogger,
  opts: { debug?: boolean; exit?: (code: number) => void } = {}
): Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  try {
    await phase()
  } catch (err: any) {
    logger.error(`${label}: ${err.message}`)
    if (opts.debug) {
      logger.error(err)
    }
    exit(1)
  }
}

/**
 * Registers a handler for `unhandledRejection` that logs through `logger.error` rather than letting
 * it fall through to Node's default behavior, which — unlike a thrown, uncaught exception — does not
 * reliably put anything useful in front of an operator: a rejection nobody attached a `.catch` to
 * anywhere in the promise chain currently only produces a process warning, easy to miss in a log
 * stream that isn't watching for it, and Node has moved its default `--unhandled-rejections` mode
 * towards terminating the process on this in recent majors, which would otherwise take an instance
 * down with nothing in `WIKI.logger`'s own backlog (`core/logger.ts`, replayed to the admin
 * terminal) to show for it.
 *
 * `exit`, when given, is called with `1` after logging: the process gives up rather than continuing
 * in a state some in-flight operation already abandoned, which is what `index.ts` wants (it passes
 * `process.exit`). `@gquittet/graceful-server`'s own `uncaughtException` handler already treats a
 * *synchronous* throw as fatal (`stop({ value: 2 })`); exiting here closes the same gap on the async
 * side. Omitted, the handler logs and lets the process carry on. Injectable rather than a bare
 * boolean for the same reason `runBootPhaseOrExit`'s is: a test can assert the call without actually
 * terminating the test runner's process.
 *
 * `target` is injectable — defaulting to the real `process` — so a test can register against a plain
 * `EventEmitter` stand-in instead of touching the actual process-wide event target.
 */
export function registerUnhandledRejectionHandler(
  logger: BootLogger,
  opts: { debug?: boolean; target?: NodeJS.EventEmitter; exit?: (code: number) => void } = {}
): void {
  const target = opts.target ?? process
  target.on('unhandledRejection', (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason)
    logger.error(`Unhandled Promise Rejection: ${message}`)
    if (opts.debug && reason instanceof Error) {
      logger.error(reason)
    }
    opts.exit?.(1)
  })
}
