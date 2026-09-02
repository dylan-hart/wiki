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
 * unmappable categories cover (see `../unmappable.ts`), otherwise `recorder.create(...)`. An entity
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
 * Wraps a real `WriteRecorder` to notice whether any `create()` call across the whole phase run was
 * ever given a `write` callback — i.e. whether *any* entity actually has a destination write path,
 * as opposed to merely classifying records for the dry-run report (see `../recorder.ts`'s own header
 * comment: `write` is optional so a phase with no real model write yet — or a source connector kind
 * that never will, like `ExportBundleSourceConnector` — can still classify for the dry-run report).
 * `dryRun` still suppresses invoking `write()` itself; this only tracks whether one was *supplied*,
 * since a dry run against a phase that genuinely can write must not be reported as `not_implemented`.
 */
function trackWriteCapability(recorder: WriteRecorder): {
  recorder: WriteRecorder
  hasWriteCapability: () => boolean
} {
  let sawWrite = false
  return {
    recorder: {
      create: (identifier, write) => {
        if (write) {
          sawWrite = true
        }
        return recorder.create(identifier, write)
      },
      skipExisting: (identifier) => recorder.skipExisting(identifier),
      conflict: (identifier, detail) => recorder.conflict(identifier, detail),
      unmappable: (identifier, reason, detail) => recorder.unmappable(identifier, reason, detail),
      snapshot: () => recorder.snapshot()
    },
    hasWriteCapability: () => sawWrite
  }
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
      const { recorder, hasWriteCapability } = trackWriteCapability(createRecorder(ctx.dryRun))
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
        // No entity in this phase ever supplied `create()` a `write` callback, so nothing this phase
        // "counted" was actually written anywhere — every entity that looked like a successful read
        // is really just an honest report of what *would* be created. Real against a
        // `PostgresSourceConnector` source (every phase has a genuine write path there), this still
        // fires for an `ExportBundleSourceConnector` source's `users`/`settings`/`assets` phases, whose
        // entity generators remain `NotYetImplementedError` stubs — bundle write support is out of this
        // plan's scope, so `readEntity()` never even reaches this reclassification for them (it already
        // returned `'not_implemented'` per-entity). Kept here for the phase where a read genuinely
        // succeeds but no write path exists at all, so an operator never sees success for a phase with
        // no destination write path.
        if (!hasWriteCapability()) {
          for (const name of Object.keys(counts)) {
            if (!notImplemented.includes(name)) {
              notImplemented.push(name)
            }
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
