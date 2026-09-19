import type { ConflictEntry, PhaseReport, UnmappableEntry, UnmappableReason } from './report.ts'

/**
 * Every would-be destination write a phase makes routes through one place, so a dry run can count a
 * record without attempting any I/O. `write` is optional: a phase with no write wired in (a bundle
 * source, a pure unit test) still classifies a record as "would create". A dry run never invokes
 * `write`; a live run awaits it before counting the create, so a write that throws is not counted
 * as done.
 */
export interface WriteRecorder {
  create(identifier: string, write?: () => Promise<void>): Promise<void>
  skipExisting(identifier: string): void
  conflict(identifier: string, detail: string): void
  unmappable(identifier: string, reason: UnmappableReason, detail: string): void
  /** Arrays are copies: a caller may hold onto or append to them without mutating the recorder. */
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

export function createRecorder(dryRun: boolean): WriteRecorder {
  return new DryRunAwareRecorder(dryRun)
}
