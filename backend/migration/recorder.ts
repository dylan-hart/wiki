import type { ConflictEntry, PhaseReport, UnmappableEntry, UnmappableReason } from './report.ts'

/**
 * Routes every would-be destination write a phase makes through one place, so dry-run mode can swap
 * in a recorder that never calls the real write — see Feature 421 task 744's description ("routing
 * every would-be INSERT/UPDATE through a no-op recorder instead of the real model write methods").
 *
 * No phase in this codebase has a real model write to give `create()` yet — that is Features
 * 414/416/418/420's job, none of which have landed (their `SourceConnector` generators are still
 * `NotYetImplementedError` stubs). `write` is therefore optional: a phase calls `create(identifier)`
 * today purely to classify a record as "would create" for the report, with no I/O attempted either
 * way. Once a real phase has a real write, it passes it as `write` and gets the dry-run/live split
 * for free — dry run never invokes it, a live run awaits it before counting the create, so a write
 * that throws is not silently counted as done.
 */
export interface WriteRecorder {
  create(identifier: string, write?: () => Promise<void>): Promise<void>
  skipExisting(identifier: string): void
  conflict(identifier: string, detail: string): void
  unmappable(identifier: string, reason: UnmappableReason, detail: string): void
  /** A fresh snapshot of everything recorded so far — arrays are copies, safe for a caller to hold
   * onto or append to (e.g. a phase merging in its `staticUnmappable` entries) without mutating the
   * recorder's own state. */
  snapshot(): Pick<PhaseReport, 'wouldCreate' | 'wouldSkipExisting' | 'conflicts' | 'unmappable'>
}

class DryRunAwareRecorder implements WriteRecorder {
  private readonly dryRun: boolean
  private created = 0
  private skipped = 0
  private readonly conflictEntries: ConflictEntry[] = []
  private readonly unmappableEntries: UnmappableEntry[] = []

  constructor(dryRun: boolean) {
    this.dryRun = dryRun
  }

  async create(_identifier: string, write?: () => Promise<void>): Promise<void> {
    if (write && !this.dryRun) {
      await write()
    }
    this.created++
  }

  skipExisting(_identifier: string): void {
    this.skipped++
  }

  conflict(identifier: string, detail: string): void {
    this.conflictEntries.push({ identifier, detail })
  }

  unmappable(identifier: string, reason: UnmappableReason, detail: string): void {
    this.unmappableEntries.push({ identifier, reason, detail })
  }

  snapshot(): ReturnType<WriteRecorder['snapshot']> {
    return {
      wouldCreate: this.created,
      wouldSkipExisting: this.skipped,
      conflicts: [...this.conflictEntries],
      unmappable: [...this.unmappableEntries]
    }
  }
}

/**
 * Builds a recorder for one phase run. `dryRun` true is what makes `create()`'s `write` callback (when
 * given) a no-op — everything else about the recorder (what gets counted, what the snapshot looks
 * like) is identical either way, which is what lets the same phase code run in both modes.
 */
export function createRecorder(dryRun: boolean): WriteRecorder {
  return new DryRunAwareRecorder(dryRun)
}
