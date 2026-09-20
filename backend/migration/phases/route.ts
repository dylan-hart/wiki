import type { WriteRecorder } from '../recorder.ts'

/**
 * The only three shapes a `PhaseReport` has a bucket for; each phase maps its importer's richer
 * outcome type onto this before routing.
 *
 * `notes` is logged verbatim, one line per entry, because neither `WriteRecorder` nor `PhaseReport`
 * has anywhere to put a per-record note on an otherwise-successful create. The caller formats each
 * line in full, since the prefix differs per phase.
 */
export type RecordOutcome =
  | { outcome: 'created'; notes?: readonly string[] }
  | { outcome: 'skipped' }
  | { outcome: 'conflicted'; detail: string }

/**
 * The write always happens *before* this is called, never as `recorder.create()`'s own `write`
 * callback. Two reasons: an importer reporting a failure by returning it rather than throwing would
 * be counted as a successful `wouldCreate`, since `create()` counts unconditionally once `write()`
 * returns; and a write that does throw propagates past `readEntity()` — which special-cases only
 * `NotYetImplementedError` — into `run()`'s catch, discarding the whole phase's report for every
 * record already imported.
 *
 * `'skipped'` is where both "already exists at the destination" and "read but deliberately not
 * written" land; `PhaseReport` has no bucket distinguishing them. `'conflicted'` is reserved for a
 * write that was genuinely attempted and failed.
 */
export async function routeOutcome(
  recorder: WriteRecorder,
  identifier: string,
  outcome: RecordOutcome,
  log?: (message: string) => void
): Promise<void> {
  switch (outcome.outcome) {
    case 'created':
      for (const note of outcome.notes ?? []) {
        log?.(note)
      }
      await recorder.create(identifier)
      return
    case 'skipped':
      recorder.skipExisting(identifier)
      return
    case 'conflicted':
      recorder.conflict(identifier, outcome.detail)
  }
}
