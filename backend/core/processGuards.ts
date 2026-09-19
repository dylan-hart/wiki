import type { LogFn } from './logger.ts'

/** Kept narrow so a test can pass a bare `{ error: mock.fn() }` instead of `CARDINAL.logger`. */
export interface BootLogger {
  error: LogFn
}

/**
 * A boot phase's rejection becomes one labelled `error` record and a deliberate exit, rather than a
 * bare stack from an unhandled rejection. `exit` is injectable so a test can assert the call
 * without terminating the test runner.
 */
export async function runBootPhaseOrExit(
  phase: () => Promise<void>,
  label: string,
  logger: BootLogger,
  opts: { exit?: (code: number) => void } = {}
): Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  try {
    await phase()
  } catch (err: any) {
    logger.error('boot', `${label} failed`, { error: err })
    exit(1)
  }
}

/**
 * Without a listener, Node's default for an unhandled rejection can take the instance down with
 * nothing in `CARDINAL.logger`'s backlog to show for it.
 *
 * `exit`, when given, runs after logging: the process gives up rather than continuing in a state an
 * in-flight operation already abandoned. `close-with-grace` treats `uncaughtException` as fatal on
 * its own but is deliberately not configured to react to `unhandledRejection` (`SKIPPED_EVENTS` in
 * `core/http/shutdown.ts`), so this must stay the only listener for it. Omitted, the handler logs
 * and the process carries on.
 *
 * `target` and `exit` are injectable so a test can register against a plain `EventEmitter` and
 * assert the exit without terminating the test runner.
 */
export function registerUnhandledRejectionHandler(
  logger: BootLogger,
  opts: { target?: NodeJS.EventEmitter; exit?: (code: number) => void } = {}
): void {
  const target = opts.target ?? process
  target.on('unhandledRejection', (reason: unknown) => {
    // -> No `error` field for a non-`Error` reason: there is no name or stack to lift out of a
    //    rejected string, and inventing one would put a fabricated trace in front of an operator.
    const message = reason instanceof Error ? reason.message : String(reason)
    logger.error(
      'boot',
      `unhandled promise rejection: ${message}`,
      reason instanceof Error ? { error: reason } : {}
    )
    opts.exit?.(1)
  })
}
