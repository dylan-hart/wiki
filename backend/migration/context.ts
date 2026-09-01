import type { WikiDb } from '../core/db.ts'
import type { SourceConnector } from './connector.ts'
import type { SystemGroupIds } from './importers/users-groups.ts'
import type { IdMap } from './id-map.ts'
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
  /** This install's real local-auth strategy id (`WIKI.data.systemIds.localAuthId`), resolved once by
   * `bootstrap.ts#resolveUsersImportContext()` — the `users` phase (Task 14) needs it to key every
   * imported account's `auth` jsonb column, the same way `Settings.init()` does for a freshly-seeded
   * install. */
  localStrategyId: string
  /** This install's real target Administrators/Guests group ids, resolved once by
   * `bootstrap.ts#resolveUsersImportContext()` — see `importers/users-groups.ts`'s module doc (Task
   * 731) for why the `userGroups` entity needs these: a membership pointing at the *source's* system
   * group (skipped, not imported) remaps onto these instead of being dropped. */
  systemGroupIds: SystemGroupIds
  /** This install's root admin user id (`WIKI.config.auth.rootAdminUserId`), resolved once by
   * `bootstrap.ts#resolveUsersImportContext()`. Not read by the `users` phase itself — carried here so
   * the `content` phase (Task 13) has a real, always-valid fallback author for content whose source
   * author could not be mapped onto an imported user. */
  operatorActorId: string
  /** Source-id -> destination-UUID map the `users` phase (Task 14) populates as a side effect of its
   * own run (`userImporter.idMap`) — read by the `content` phase (Task 13, `dependsOn: ['users']`) to
   * resolve a staged page/comment's author. Optional because it does not exist before the `users`
   * phase has actually run (e.g. a hand-built `MigrationContext` in a test fixture that never runs
   * that phase). */
  userIdMap?: Map<number, string>
  /** Old-`pages.id` -> destination-UUID map the `content` phase (Task 13) populates as a live
   * reference (`pageImporter.pageIdMap`) once its `pages` entity has started running — handed to the
   * assets/comments phase (Task 16, `dependsOn: ['content']`) to resolve a staged asset/comment's
   * owning page. Optional for the same reason `userIdMap` is: it does not exist before the `content`
   * phase has run. */
  pageIdMap?: IdMap<number>
  /** This install's target site's own primary locale
   * (`WIKI.sites[siteId].config.locales.primary`), resolved once by `bootstrap.ts`'s
   * `resolveUsersImportContext()` (called with `siteId` now, for exactly this) — the `content` phase
   * (Task 13) needs it to pick which one of 2.x's per-locale navigation trees becomes 3.0's single,
   * locale-less site-wide menu (`navigation-import.ts`'s `NavigationImportOptions.locale`). */
  primaryLocale: string
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
