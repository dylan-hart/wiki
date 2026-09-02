import { NotYetImplementedError } from '../connector.ts'
import { createRecorder } from '../recorder.ts'
import { emptyPhaseReport } from '../report.ts'
import type { WriteRecorder } from '../recorder.ts'
import type { MigrationContext, MigrationPhase, MigrationPhaseId, PhaseResult } from '../context.ts'

/**
 * One entity a phase reads off the source connector.
 *
 * `classify`, when given, is called for every record read and decides how it counts toward the
 * phase's `PhaseReport` — typically `recorder.unmappable(...)` for a record this task's named
 * unmappable categories cover (see `../report.ts`), otherwise `recorder.create(...)`. An entity
 * that omits it still gets every record it reads counted as a plain "would create" via the default
 * below — the correct behavior for an entity this task has no per-record reconciliation rule for.
 */
export interface PhaseEntity {
  source: () => AsyncIterable<unknown>
  classify?: (record: unknown, recorder: WriteRecorder) => void | Promise<void>
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
 * Exhausts one entity's source generator, running `classify` (or the default) per record and counting
 * how many were read — the harness never needs the records themselves once classified, only how many
 * the source reports and how each one was classified.
 *
 * An entity generator that is still a `NotYetImplementedError` stub — real against a
 * `PostgresSourceConnector` source today, still true of most of `ExportBundleSourceConnector`'s
 * generators (`users`/`groups`/`settings`/`comments`/`assets` — bundle write support is out of this
 * plan's scope) — resolves to `'not_implemented'` rather than aborting the whole phase, so an operator
 * running the CLI against either connector kind gets a clean per-phase report instead of a crash. Any
 * other error propagates, since that is a real fault (a bad connection, a malformed row) the operator
 * needs to see.
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
  return count
}

/**
 * Builds one `MigrationPhase` from its id/label/dependencies plus the source entities it reads,
 * wrapping the read in structured success/not-implemented/error reporting (`PhaseResult`) and, on top
 * of that, the dry-run/report-mode reconciliation every phase now produces (`PhaseResult.report`, see
 * Feature 421 task 744 and `../report.ts`).
 */
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
