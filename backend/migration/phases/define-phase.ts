import { NotYetImplementedError } from '../connector.ts'
import { createRecorder } from '../recorder.ts'
import { emptyPhaseReport } from '../report.ts'
import type { WriteRecorder } from '../recorder.ts'
import type { MigrationContext, MigrationPhase, MigrationPhaseId, PhaseResult } from '../context.ts'

/**
 * `classify` decides how each record read counts toward the phase's `PhaseReport`. An entity that
 * omits it still counts every record as a plain "would create".
 */
export interface PhaseEntity {
  source: () => AsyncIterable<unknown>
  classify?: (record: unknown, recorder: WriteRecorder) => void | Promise<void>
  /**
   * Runs once after `source()` is fully exhausted, never for a `NotYetImplementedError` stub. For an
   * entity needing a second pass over what `classify` accumulated (a forward reference that cannot
   * resolve until every record has a destination id), rather than a synthetic extra entity that
   * would pollute `PhaseResult.counts`.
   */
  onComplete?: () => void | Promise<void>
}

function identifierFor(record: unknown, fallback: number): string {
  if (typeof record === 'object' && record !== null && 'id' in record) {
    return String((record as Record<string, unknown>).id)
  }
  return String(fallback)
}

async function defaultClassify(
  record: unknown,
  recorder: WriteRecorder,
  index: number
): Promise<void> {
  await recorder.create(identifierFor(record, index))
}

/**
 * A source generator that is still a `NotYetImplementedError` stub resolves to `'not_implemented'`
 * rather than aborting the phase, so an operator gets a clean per-phase report instead of a crash.
 * Any other error propagates: that is a real fault the operator needs to see.
 */
async function readEntity(
  entity: PhaseEntity,
  recorder: WriteRecorder
): Promise<number | 'not_implemented'> {
  let count = 0
  try {
    for await (const record of entity.source()) {
      count++
      if (entity.classify) {
        await entity.classify(record, recorder)
      } else {
        await defaultClassify(record, recorder, count)
      }
    }
  } catch (err: any) {
    if (err instanceof NotYetImplementedError) {
      return 'not_implemented'
    }
    throw err
  }
  if (entity.onComplete) {
    await entity.onComplete()
  }
  return count
}

export function definePhase(config: {
  id: MigrationPhaseId
  label: string
  dependsOn: MigrationPhaseId[]
  entities: (ctx: MigrationContext) => Record<string, PhaseEntity>
}): MigrationPhase {
  return {
    id: config.id,
    label: config.label,
    dependsOn: config.dependsOn,
    async run(ctx: MigrationContext): Promise<PhaseResult> {
      const startedAt = performance.now()
      const recorder = createRecorder(ctx.dryRun)
      const counts: Record<string, number> = {}
      const notImplemented: string[] = []
      try {
        for (const [name, entity] of Object.entries(config.entities(ctx))) {
          const result = await readEntity(entity, recorder)
          if (result === 'not_implemented') {
            notImplemented.push(name)
          } else {
            counts[name] = result
          }
        }
        const durationMs = performance.now() - startedAt
        const snapshot = recorder.snapshot()
        const report = {
          phase: config.id,
          found: Object.values(counts).reduce((sum, n) => sum + n, 0),
          wouldCreate: snapshot.wouldCreate,
          wouldSkipExisting: snapshot.wouldSkipExisting,
          conflicts: snapshot.conflicts,
          unmappable: snapshot.unmappable
        }
        if (notImplemented.length > 0) {
          return {
            phase: config.id,
            status: 'not_implemented',
            counts,
            notImplemented,
            durationMs,
            report
          }
        }
        return { phase: config.id, status: 'ok', counts, durationMs, report }
      } catch (err: any) {
        return {
          phase: config.id,
          status: 'error',
          errors: [err.message],
          durationMs: performance.now() - startedAt,
          report: emptyPhaseReport(config.id)
        }
      }
    }
  }
}
