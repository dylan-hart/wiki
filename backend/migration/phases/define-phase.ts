import { NotYetImplementedError } from '../connector.ts'
import type { MigrationContext, MigrationPhase, MigrationPhaseId, PhaseResult } from '../context.ts'

/** Exhausts one entity generator, counting rows/files rather than buffering them — the harness never
 * needs the records themselves, only how many the source reports, until the tasks that own each
 * phase's row-transformation logic (414/416/418/420) fill in real writes. */
async function countEntity(factory: () => AsyncIterable<unknown>): Promise<number> {
  let count = 0
  for await (const _record of factory()) {
    count++
  }
  return count
}

/**
 * Reads every entity a phase declares off the source connector, in whatever order `Object.entries`
 * gives them (insertion order, so callers get a stable, readable result).
 *
 * An entity generator that is still a `NotYetImplementedError` stub — every one of them, until
 * Features 414/416/418/420 land — is collected into `notImplemented` rather than aborting the whole
 * phase, so an operator running the CLI today gets a clean per-phase report instead of a crash. Any
 * other error propagates, since that is a real fault (a bad connection, a malformed row) the operator
 * needs to see.
 */
async function readPhaseEntities(
  entities: Record<string, () => AsyncIterable<unknown>>
): Promise<{ counts: Record<string, number>; notImplemented: string[] }> {
  const counts: Record<string, number> = {}
  const notImplemented: string[] = []
  for (const [name, factory] of Object.entries(entities)) {
    try {
      counts[name] = await countEntity(factory)
    } catch (err: any) {
      if (err instanceof NotYetImplementedError) {
        notImplemented.push(name)
      } else {
        throw err
      }
    }
  }
  return { counts, notImplemented }
}

/**
 * Builds one `MigrationPhase` from its id/label/dependencies plus the source entities it reads,
 * wrapping the read in structured success/not-implemented/error reporting — see `PhaseResult`.
 */
export function definePhase(config: {
  id: MigrationPhaseId
  label: string
  dependsOn: MigrationPhaseId[]
  entities: (ctx: MigrationContext) => Record<string, () => AsyncIterable<unknown>>
}): MigrationPhase {
  return {
    id: config.id,
    label: config.label,
    dependsOn: config.dependsOn,
    async run(ctx: MigrationContext): Promise<PhaseResult> {
      const startedAt = performance.now()
      try {
        const { counts, notImplemented } = await readPhaseEntities(config.entities(ctx))
        const durationMs = performance.now() - startedAt
        if (notImplemented.length > 0) {
          return { phase: config.id, status: 'not_implemented', counts, notImplemented, durationMs }
        }
        return { phase: config.id, status: 'ok', counts, durationMs }
      } catch (err: any) {
        return {
          phase: config.id,
          status: 'error',
          errors: [err.message],
          durationMs: performance.now() - startedAt
        }
      }
    }
  }
}
