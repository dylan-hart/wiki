import type { MigrationContext, MigrationPhase, MigrationPhaseId, PhaseResult } from './context.ts'

export interface RunMigrationOptions {
  /** Phase id(s) to run instead of the full sequence — how an operator re-runs just one phase after
   * fixing a conflict. Not auto-expanded to include dependencies: an operator selecting one phase
   * already knows what it needs re-run. */
  only?: MigrationPhaseId[]
}

/**
 * A phase failing (`status: 'error'`) does not stop the sequence — the operator gets one report
 * covering every phase that ran, which is what makes `--only` a useful way to retry just the phase
 * that failed instead of re-running everything.
 *
 * `options.only` is already validated against `MIGRATION_PHASE_IDS` by `cli.ts`'s `parseOnly()`, so an
 * unknown id never reaches here.
 */
export async function runMigration(
  phases: MigrationPhase[],
  ctx: MigrationContext,
  options: RunMigrationOptions = {}
): Promise<PhaseResult[]> {
  const { only } = options
  const selected = only ? phases.filter((phase) => only.includes(phase.id)) : phases

  const results: PhaseResult[] = []
  for (const phase of selected) {
    ctx.log?.(`Running phase "${phase.id}" (${phase.label})...`)
    const result = await phase.run(ctx)
    ctx.log?.(`Phase "${phase.id}" finished: ${result.status}`)
    results.push(result)
  }
  return results
}
