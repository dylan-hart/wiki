import type { WikiDb } from '../core/db.ts'
import type { SourceConnector } from './connector.ts'
import type { PhaseReport } from './report.ts'

/**
 * The four import phases the migration CLI sequences, in the dependency order Feature 421 specifies:
 * settings/auth/storage config (Feature 420) before users/groups/permissions (414), before content
 * (416), before assets/comments-staging (418). Each id is also the `--only=<id>` value an operator
 * passes to re-run a single phase after fixing a conflict.
 */
export type MigrationPhaseId = 'settings' | 'users' | 'content' | 'assets'

/** How a phase came out. `notImplemented` covers the current state of every phase body: the entity
 * generators they read from (`SourceConnector`) are still `NotYetImplementedError` stubs until
 * Features 414/416/418/420 implement them — this harness only owns sequencing and result collection,
 * not the row-transformation logic those Features will fill in. */
export type PhaseStatus = 'ok' | 'not_implemented' | 'error'

/** What one phase run reports back to the harness, instead of writing to global state itself. */
export interface PhaseResult {
  phase: MigrationPhaseId
  status: PhaseStatus
  /** Records seen per source entity this phase reads, when the read succeeded. */
  counts?: Record<string, number>
  /** Entity names whose generator is still a `NotYetImplementedError` stub. */
  notImplemented?: string[]
  /** Error message(s) encountered, when `status` is `'error'`. */
  errors?: string[]
  durationMs: number
  /** The dry-run/report-mode reconciliation for this phase — see Feature 421 task 744. Optional so a
   * hand-built `PhaseResult` (e.g. in a test fixture) doesn't have to supply one; every phase built via
   * `definePhase` always sets it. */
  report?: PhaseReport
}

/**
 * Shared state every phase reads and reports through, rather than each phase reaching into `WIKI.*`
 * or talking to another phase's output directly — see Feature 421 task 742's description.
 */
export interface MigrationContext {
  /** The 3.0 destination, from this CLI's own `dbManager.init()` — never the 2.x source. */
  db: WikiDb
  /** The connected 2.x source, however it was configured (live Postgres or an export bundle). */
  source: SourceConnector
  /** Destination site ID content/users/etc. are imported into. */
  siteId: string
  /** When true, phases must compute without writing — the actual dry-run reconciliation logic
   * (counts of creates/skips/conflicts) is Feature 421 task 744's; this harness only carries the
   * flag through so every phase and the entity generators it calls can see it. */
  dryRun: boolean
  /** Optional progress sink; defaults to doing nothing so the harness is usable without a logger. */
  log?: (message: string) => void
}

/** One phase in the sequence, plus the dependency ids it declares for documentation and future
 * idempotency tooling (Feature 421 task 746) — `runMigration` does not auto-include dependencies of
 * an `--only` selection, since an operator selecting one phase already knows what it needs. */
export interface MigrationPhase {
  id: MigrationPhaseId
  label: string
  dependsOn: MigrationPhaseId[]
  run(ctx: MigrationContext): Promise<PhaseResult>
}
