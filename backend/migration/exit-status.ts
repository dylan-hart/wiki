import type { MigrationPhaseId, PhaseResult } from './context.ts'

/**
 * Pure exit-code policy for `tasks/migrate.ts`'s CLI — pulled into its own module (rather than living
 * inline in `migrate.ts`, where it started, or being exported from there) specifically so it can be
 * unit-tested with no live `WIKI`/db needed. `tasks/migrate.ts` cannot safely be `import`ed by a test
 * file at all: its own module-top-level `main().catch(...)` call runs unconditionally the moment the
 * module loads, attempting to parse `process.argv` as migration CLI args and boot a real destination
 * connection — exactly the "never import this file" constraint `migrate.test.ts`'s own module doc
 * already documents (it reads `migrate.ts` as plain text via `fs.readFile()`, never as an ES import,
 * for this exact reason). A function `migrate.ts` merely re-exported would inherit that same hazard for
 * any test that imported it. Living here instead, `migrate.ts` imports these two functions the normal
 * way, and a test imports this module directly with no side effect at all.
 */

/** The `status: 'not_implemented'` phases out of a migration run's results, in run order. */
export function notImplementedPhaseIds(results: PhaseResult[]): MigrationPhaseId[] {
  return results
    .filter((result) => result.status === 'not_implemented')
    .map((result) => result.phase)
}

/**
 * The CLI's own `process.exitCode` — non-zero when any phase genuinely errored, OR (whole-branch review
 * Important #4) when this was a live (non-dry-run) run and at least one phase had no real write path at
 * all against the source in use.
 *
 * Design spec §3: once real writes existed, the CLI's old blanket "no phase can write yet" refusal was
 * meant to be "replaced with a check that fails clearly if a *specific* phase still lacks one" — never
 * built until now. Concretely: `--bundle-path` (`ExportBundleSourceConnector`) still stubs
 * `users`/`groups`/`settings`/`comments`/`assets` with `NotYetImplementedError` (bundle write support is
 * explicitly out of this plan's scope — see `tasks/migrate.ts`'s own module doc), so a LIVE (non-dry-run)
 * run against a bundle source really imports pages/history/tags/navigation — with an empty `userIdMap`,
 * silently reassigning every page's author to the operator — while every other phase reports
 * `not_implemented`, and `process.exitCode` used to stay 0 regardless, since it was only ever set
 * non-zero on `status: 'error'`.
 *
 * `dryRun` deliberately exempts the second condition: `status: 'not_implemented'` is the normal,
 * expected outcome for a phase whose entity generator is still a stub, and a dry run was never going to
 * write anything for ANY phase — flagging that as a failure would make every dry run against a bundle
 * source red, which is not what a rehearsal is for.
 */
export function computeExitCode(results: PhaseResult[], dryRun: boolean): number {
  const hasError = results.some((result) => result.status === 'error')
  const hasIncompleteLiveRun = !dryRun && notImplementedPhaseIds(results).length > 0
  return hasError || hasIncompleteLiveRun ? 1 : 0
}
