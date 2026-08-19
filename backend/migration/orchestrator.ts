import type { MigrationContext, MigrationPhase, MigrationPhaseId, PhaseResult } from './context.ts'

export interface RunMigrationOptions {
  /** Phase id(s) to run instead of the full sequence — how an operator re-runs just one phase (e.g.
   * `--only=content`) after fixing a conflict. Not auto-expanded to include dependencies: an operator
   * selecting one phase already knows what it needs re-run. */
  only?: MigrationPhaseId[]
}

/**
 * Runs the given phases in the order they are passed, passing every one the same shared `ctx` rather
 * than letting phases talk to global state or each other directly, and collecting each phase's
 * structured `PhaseResult` instead of having each write its own outcome somewhere.
 *
 * A phase failing (`status: 'error'`) does not stop the sequence — the operator gets one report
 * covering every phase that ran, which is what makes `--only` a useful way to retry just the phase
 * that failed instead of re-running everything.
 *
 * @throws synchronously, before any phase runs, if `options.only` names a phase id not present in
 * `phases` — a typo in `--only` should fail fast, not silently run zero phases.
 */
export async function runMigration(
  phases: MigrationPhase[],
  ctx: MigrationContext,
  options: RunMigrationOptions = {}
): Promise<PhaseResult[]> {
  const knownIds = phases.map((phase) => phase.id)
  const { only } = options

  let selected = phases
  if (only) {
    const unknown = only.filter((id) => !knownIds.includes(id))
    if (unknown.length > 0) {
      throw new Error(
        `Unknown phase(s) in --only: ${unknown.join(', ')}. Known phases: ${knownIds.join(', ')}.`
      )
    }
    selected = phases.filter((phase) => only.includes(phase.id))
  }

  const results: PhaseResult[] = []
  for (const phase of selected) {
    ctx.log?.(`Running phase "${phase.id}" (${phase.label})...`)
    const result = await phase.run(ctx)
    ctx.log?.(`Phase "${phase.id}" finished: ${result.status}`)
    results.push(result)
  }
  return results
}
