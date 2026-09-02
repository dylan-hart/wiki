import type { WriteRecorder } from '../recorder.ts'

/**
 * How one already-attempted per-record import landed, in the only three shapes a `PhaseReport` has a
 * bucket for. Each phase maps its own importer's richer outcome type (`RecordStatus`,
 * `PageImportOutcome`, an `importAsset()`/`importComment()` result) onto this before routing.
 *
 * `notes` is logged verbatim, one line per entry, before the create is counted. Neither `WriteRecorder`
 * nor `PhaseReport` has anywhere to put a per-record note on an otherwise-successful create (see
 * `../report.ts`'s own doc comment on that reporting-shape gap), so a converter's note — a group's
 * dropped permissions/rules, a page's history-backfill warning — would otherwise be silently
 * discarded. The caller formats each line in full, since the prefix differs per phase.
 */
export type RecordOutcome =
  | { outcome: 'created'; notes?: readonly string[] }
  | { outcome: 'skipped' }
  | { outcome: 'conflicted'; detail: string }

/**
 * Routes one already-written record's outcome onto the matching `WriteRecorder` call, so a phase's
 * `PhaseReport` snapshot (`wouldCreate`/`wouldSkipExisting`/`conflicts`) reflects what each record
 * actually resolved to.
 *
 * The write itself always happens *before* this is called, never as `recorder.create()`'s own `write`
 * callback. Two reasons, both learned the hard way in the `users`/`content`/`assets` phases this
 * replaces the per-phase copies of: an importer that reports a failure by returning it (rather than
 * throwing) would be counted as a successful `wouldCreate`, since `create()` counts unconditionally
 * once `write()` returns; and a write that *does* throw propagates straight out of `classify()` past
 * `define-phase.ts#readEntity()` — which only special-cases `NotYetImplementedError` — into
 * `definePhase()`'s own `run()` catch, discarding the whole phase's report for every record already
 * imported in the same run.
 *
 * `'skipped'` is where "already exists at the destination" and "read but deliberately not written"
 * both land: `WriteRecorder`/`PhaseReport` have no dedicated "needs admin attention" bucket distinct
 * from either (see `../report.ts`'s closed shape — `found === wouldCreate + wouldSkipExisting +
 * conflicts.length + unmappable.length`). `'conflicted'` is reserved for a write that was genuinely
 * attempted and failed.
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
