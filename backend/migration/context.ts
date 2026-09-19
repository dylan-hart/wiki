import type { WikiDb } from '../core/db.ts'
import type { SourceConnector } from './connector.ts'
import type { SystemGroupIds } from './importers/users-groups.ts'
import type { PhaseReport } from './report.ts'

/**
 * The four import phases, in the dependency order the CLI sequences them: settings/auth/storage
 * config, then users/groups/permissions, then content, then assets/comments. Each id is also the
 * `--only=<id>` value an operator passes to re-run a single phase after fixing a conflict.
 */
export type MigrationPhaseId = 'settings' | 'users' | 'content' | 'assets'

/** How a phase came out. `not_implemented` is the honest, non-crashing outcome for an entity whose
 * generator is still a `NotYetImplementedError` stub on the connector kind actually in use. */
export type PhaseStatus = 'ok' | 'not_implemented' | 'error'

/** What one phase run reports back to the harness, instead of writing to global state itself. */
export interface PhaseResult {
  phase: MigrationPhaseId
  status: PhaseStatus
  /** Records seen, keyed by source entity, when the read succeeded. */
  counts?: Record<string, number>
  /** Entity names whose generator is still a `NotYetImplementedError` stub. */
  notImplemented?: string[]
  errors?: string[]
  durationMs: number
  /** Optional only so a hand-built fixture need not supply one; every phase built through
   * `definePhase` sets it. */
  report?: PhaseReport
}

/**
 * Shared state every phase reads and reports through, rather than each phase reaching into
 * `CARDINAL.*` or talking to another phase's output directly.
 */
export interface MigrationContext {
  /** The 3.0 destination — never the 2.x source. */
  db: WikiDb
  /** The 2.x source, already connected. */
  source: SourceConnector
  siteId: string
  /** Phases must compute without writing when set; each phase and every entity generator it calls
   * sees it. */
  dryRun: boolean
  log?: (message: string) => void
  /** This install's local-auth strategy id: what the `users` phase keys every imported account's
   * `auth` jsonb column on, the same way `Settings.init()` does for a freshly-seeded install. */
  localStrategyId: string
  /** The destination's own Administrators/Guests group ids: a membership naming the *source's*
   * system group (skipped, never imported) remaps onto these instead of being dropped. */
  systemGroupIds: SystemGroupIds
  /** The root admin user id, carried here so the `content` phase has an always-valid fallback
   * author for content whose source author could not be mapped onto an imported user. */
  operatorActorId: string
  /** Populated by the `users` phase as it runs, read by `content` to resolve a staged page's or
   * comment's author. Absent until that phase has actually run. */
  userIdMap?: Map<number, string>
  /** Populated by the `content` phase as its `pages` entity runs, read by the assets/comments phase
   * to resolve an asset's or comment's owning page. Absent until that phase has actually run. */
  pageIdMap?: Map<number, string>
  /** How the `content` phase seeds each imported page's initial render: `'queue'` for a native 3.0
   * render (correct asset URLs and markdown-it plugin output, at one headless-browser render per
   * markdown page) or `'passthrough'` to carry 2.x's already-rendered HTML through unchanged
   * (instant, but it keeps 2.x's asset-URL convention — no `/_files/` prefix — until the page is
   * next edited or re-rendered). The CLI's `'auto'` is resolved to one of the two before any
   * context is built, so a phase never sees it. */
  renderMode?: 'passthrough' | 'queue'
}

/** One phase in the sequence. `dependsOn` is declarative only: `runMigration` does not auto-include
 * the dependencies of an `--only` selection, since an operator picking one phase knows what it
 * needs. */
export interface MigrationPhase {
  id: MigrationPhaseId
  label: string
  dependsOn: MigrationPhaseId[]
  run(ctx: MigrationContext): Promise<PhaseResult>
}

/**
 * The destination site's CURRENT primary locale, read fresh off `CARDINAL.sites` rather than
 * snapshotted before the run: the `settings` phase runs first and can rewrite
 * `config.locales.primary` from 2.x's `lang.code`, and a value captured at the start of the run
 * leaves every later phase writing under the destination's pre-migration locale instead.
 * `updateSite()` reloads the cache synchronously, so a later phase already sees the new value.
 *
 * A dry run answers `'en'` without touching `CARDINAL` at all, so the pure phase unit tests can run
 * with no global installed. That costs a dry run's locale preview only — a dry run never writes.
 */
export function resolvePrimaryLocale(ctx: Pick<MigrationContext, 'siteId' | 'dryRun'>): string {
  if (ctx.dryRun) {
    return 'en'
  }
  return CARDINAL.sites[ctx.siteId]?.config?.locales?.primary ?? 'en'
}
