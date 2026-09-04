import type { WikiDb } from '../core/db.ts'
import type { SourceConnector } from './connector.ts'
import type { SystemGroupIds } from './importers/users-groups.ts'
import type { PhaseReport } from './report.ts'

/**
 * The four import phases the migration CLI sequences, in the dependency order Feature 421 specifies:
 * settings/auth/storage config (Feature 420) before users/groups/permissions (414), before content
 * (416), before assets/comments-staging (418). Each id is also the `--only=<id>` value an operator
 * passes to re-run a single phase after fixing a conflict.
 */
export type MigrationPhaseId = 'settings' | 'users' | 'content' | 'assets'

/** How a phase came out. `notImplemented` is set when one of a phase's entity generators is still a
 * `NotYetImplementedError` stub for the connector kind actually in use. Every phase has a real
 * generator and a real write path against a `PostgresSourceConnector` source; this
 * status is still the honest, non-crashing outcome for the entities `ExportBundleSourceConnector`
 * leaves stubbed (`users`/`groups`/`settings`/`comments`/`assets` — bundle write support is explicitly
 * out of this plan's scope, see `tasks/migrate.ts`'s own module doc), and for any hand-built
 * `MigrationContext`/`SourceConnector` a test wires up with no write path at all. */
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
   * `bootstrap.ts#resolveUsersImportContext()` — the `users` phase needs it to key every
   * imported account's `auth` jsonb column, the same way `Settings.init()` does for a freshly-seeded
   * install. */
  localStrategyId: string
  /** This install's real target Administrators/Guests group ids, resolved once by
   * `bootstrap.ts#resolveUsersImportContext()` — see `SystemGroupIds`' own doc comment
   * (`importers/users-groups.ts`) for why the `userGroups` entity needs these, and for where each id
   * actually lives at runtime: a membership pointing at the *source's* system group (skipped, not
   * imported) remaps onto these instead of being dropped. */
  systemGroupIds: SystemGroupIds
  /** This install's root admin user id (`WIKI.config.auth.rootAdminUserId`), resolved once by
   * `bootstrap.ts#resolveUsersImportContext()`. Not read by the `users` phase itself — carried here so
   * the `content` phase has a real, always-valid fallback author for content whose source
   * author could not be mapped onto an imported user. */
  operatorActorId: string
  /** Source-id -> destination-UUID map the `users` phase populates as a side effect of its
   * own run (`userImporter.idMap`) — read by the `content` phase (`dependsOn: ['users']`) to
   * resolve a staged page/comment's author. Optional because it does not exist before the `users`
   * phase has actually run (e.g. a hand-built `MigrationContext` in a test fixture that never runs
   * that phase). */
  userIdMap?: Map<number, string>
  /** Old-`pages.id` -> destination-UUID map the `content` phase populates as a live
   * reference (`pageImporter.pageIdMap`) once its `pages` entity has started running — handed to the
   * assets/comments phase (`dependsOn: ['content']`) to resolve a staged asset/comment's
   * owning page. Optional for the same reason `userIdMap` is: it does not exist before the `content`
   * phase has run. */
  pageIdMap?: Map<number, string>
  /** How the `content` phase seeds each imported page's initial render — `'queue'` for a native 3.0
   * render (correct asset URLs, correct markdown-it plugin output, at the cost of one headless-browser
   * render per markdown page) or `'passthrough'` to carry 2.x's already-rendered HTML straight through
   * unchanged (instant, but that HTML reflects 2.x's own renderer and asset-URL convention — notably,
   * an asset reference with no `/_files/` prefix, since 2.x never used one — until the page is next
   * edited or explicitly re-rendered). Resolved to one of these two concrete values before a
   * `MigrationContext` is ever built (`tasks/migrate.ts`'s `resolveRenderMode()` — see its own doc
   * comment for the `'auto'` CLI default's Puppeteer-availability check); phases never see `'auto'`
   * themselves. Optional, defaulting to `'passthrough'`, only for a hand-built `MigrationContext` that
   * skips it entirely (a unit test exercising `content.ts` alone). */
  renderMode?: 'passthrough' | 'queue'
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

/**
 * Resolves the destination site's CURRENT primary locale — read fresh off `WIKI.sites`, never
 * snapshotted once before any phase runs. `MigrationContext` used to carry a `primaryLocale` field,
 * populated by `bootstrap.ts#resolveUsersImportContext()` before `runMigration()` ever started (whole-
 * branch review Critical #1). That field always read the destination's PRE-migration locale, because
 * the `settings` phase — which runs first (`dependsOn: []`) and can rewrite `WIKI.sites[siteId]
 * .config.locales.primary` via `mapSiteSettings()`'s `siteConfigPatch.locales` (from 2.x's `lang.code`)
 * — updates the destination through `WIKI.models.sites.updateSite()`, which the `content`/`assets`
 * phases (both transitively `dependsOn: ['settings']`, via `content`'s `dependsOn: ['users']` and
 * `users`' own `dependsOn: ['settings']`) never re-read: they kept using the stale value captured at
 * the very start of the run. A non-English 2.x source therefore had every imported asset/nav write land
 * under `'en'` — the destination's pre-migration default — instead of the locale `settings` had just
 * set.
 *
 * `WIKI.models.sites.updateSite()` calls `broadcastReload()` -> `reloadCache()` synchronously before it
 * resolves, so `WIKI.sites[siteId]` is already the post-`settings`-phase value by the time any later
 * phase in `MIGRATION_PHASES`' sequential run order (`orchestrator.ts` awaits each phase fully before
 * starting the next) actually calls this. Calling it before `settings` has run (a phase invoked in
 * isolation via `--only`, or a hand-built `MigrationContext` in a unit test) simply reads whatever
 * `WIKI.sites` already holds — the destination's real current config, same as any other live read.
 *
 * Falls back to `'en'` (never throws) under `ctx.dryRun`, without touching `WIKI` at all — the same
 * "keep a dry run fully WIKI-free" choice `phases/content.ts`'s `existingEntry`/`pagesModel.createPage`
 * already make purely for testability (see that file's own "Dry run" doc section): this phase's pure
 * unit tests (`phases/phases.test.ts`) run with `dryRun: true` and no live `WIKI` global at all, so
 * reading `WIKI.sites` unconditionally here would throw `ReferenceError: WIKI is not defined` in every
 * one of them. The tradeoff only affects a dry run's own report-only navigation-locale-selection
 * preview, never a real write, which never happens under `dryRun` regardless. A live run (`dryRun:
 * false`) mirrors `models/assets.ts#getAssetByPath()`'s own `WIKI.sites[siteId]?.config?.locales
 * ?.primary ?? 'en'` precedent for the same defensive fallback.
 */
export function resolvePrimaryLocale(ctx: Pick<MigrationContext, 'siteId' | 'dryRun'>): string {
  if (ctx.dryRun) {
    return 'en'
  }
  return WIKI.sites[ctx.siteId]?.config?.locales?.primary ?? 'en'
}
