import type { MigrationPhaseId, PhaseResult } from './context.ts'

/**
 * Pure exit-code policy for `tasks/migrate.ts`'s CLI, in its own module so a test can import it at
 * all: `migrate.ts` runs `main().catch(...)` at module top level, so importing it — even to reach a
 * function it merely re-exports — parses `process.argv` and opens a real destination connection.
 */

export function notImplementedPhaseIds(results: PhaseResult[]): MigrationPhaseId[] {
  return results
    .filter((result) => result.status === 'not_implemented')
    .map((result) => result.phase)
}

/**
 * The CLI's `process.exitCode`: non-zero when a phase errored, or when a LIVE run left a phase with
 * no real write path against the source in use. A bundle source stubs most phases, so such a run
 * imports pages with an empty `userIdMap` — silently reassigning every page's author to the
 * operator — and must not report success.
 *
 * `dryRun` exempts the second condition: `not_implemented` is the expected outcome for a stubbed
 * generator, and a rehearsal was never going to write for any phase.
 */
export function computeExitCode(results: PhaseResult[], dryRun: boolean): number {
  const hasError = results.some((result) => result.status === 'error')
  const hasIncompleteLiveRun = !dryRun && notImplementedPhaseIds(results).length > 0
  return hasError || hasIncompleteLiveRun ? 1 : 0
}
