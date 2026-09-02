/**
 * Post-import verification — Feature 421 task 748.
 *
 * Two independent checks, both meant to run after a real (non-dry-run) migration:
 *
 * 1. **Record-count reconciliation**: for each entity type the harness knows about, count what the
 *    source reports and what actually landed at the 3.0 destination, and flag any mismatch. Also,
 *    where a dry-run report (`--report-file`, task 744) was captured before the run, cross-check the
 *    live totals against what that report predicted per phase — a genuine surprise (the live count
 *    disagreeing with what the dry run itself said it would do) is a stronger signal than a bare
 *    source-vs-destination mismatch, which could just mean the source changed between runs.
 * 2. **Content-integrity spot-check**: for a sample of pages (random or explicit), hash-compare the
 *    source's raw body against the destination's stored `pages.content`, to catch truncation/encoding
 *    corruption that a row-count match alone would never reveal (a page that imported "successfully"
 *    but with its body cut off half way through still counts as 1 row either side). Deliberately
 *    `content`, not `render`: `createPage()` never stores the render it was given verbatim — it
 *    recomputes one via `WIKI.models.rendering.postProcess()` (sanitize, cheerio transforms,
 *    re-serialize), so a render-vs-render hash comparison would report a mismatch for essentially
 *    every real page. `content` is the one field `createPage()` stores unmodified.
 *
 * Every entity generator this reads through `SourceConnector` is real against a `PostgresSourceConnector`
 * source, now that Features 414/416/418/420 have landed — the whole-branch reset this file is part of
 * built genuine write paths for every phase against that connector kind. `ExportBundleSourceConnector`
 * is the one that still stubs most of them out with `NotYetImplementedError` (`users`/`groups`/
 * `settings`/`comments`/`assets` — export-bundle write support is explicitly out of this plan's scope,
 * see `tasks/migrate.ts`'s own module doc), which is exactly the case this module was built to handle
 * honestly rather than assume away: a `NotYetImplementedError` is caught and reported as
 * `'not_implemented'` for that entity rather than crashing the whole verification run, so a verify run
 * against a bundle source still produces a real report for whatever it *can* read (`pages`/`pageHistory`/
 * `tags`/`navigation`) instead of failing outright.
 */

import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { assets, groups, navigation, pageHistory, pages, users } from '../db/schema.ts'
import { NotYetImplementedError } from './connector.ts'
import { deriveUserGroupsFromEmbeddedGroups } from './importers/users-groups.ts'
import { normalizeMigratedPath } from './path-normalization.ts'
import type { WikiDb } from '../core/db.ts'
import type { MigrationPhaseId } from './context.ts'
import type { SourceConnector, SourceRecord } from './connector.ts'
import type { PhaseReport } from './report.ts'

// ----------------------------------------
// Entities
// ----------------------------------------

/** Every entity type task 748's description names for row-count reconciliation. Deliberately
 * `navigation` too, even though no `MigrationPhase` reads `SourceConnector.navigation()` yet (see
 * `phases/settings.ts`) — the description names it explicitly, and the connector interface already
 * has the generator waiting for Task 420 to wire it up. */
export const VERIFY_ENTITIES = [
  'users',
  'groups',
  'pages',
  'pageHistory',
  'tags',
  'assets',
  'navigation'
] as const
export type VerifyEntity = (typeof VERIFY_ENTITIES)[number]

/** Which current `MigrationPhase` (see `phases/index.ts`) reads a given entity as its own dedicated,
 * 1:1-countable `PhaseEntity` — this is what lets a live count be cross-checked against a captured
 * dry-run `PhaseReport.found`. `undefined` means no phase owns it *this way*, either because nothing
 * reads it yet or because a phase reads it but cannot report a matching per-record count for it (see
 * below).
 *
 * `pageHistory`/`tags` are `undefined`, not `'content'`: as of Task 13's content-staging rewrite,
 * `phases/content.ts` no longer gives either one its own entity — both are merged into `StagedPage`
 * (`content-staging.ts`'s merge-join for history, its denormalized-tags-on-page-rows design for tags),
 * so there is no separate `readEntity()` count for either any more (`content.ts`'s own doc comment:
 * "there is no separate raw connector.pageHistory()/connector.tags() read left at the phase level to
 * report a count for"). Summing `sourceCounts.pageHistory`/`sourceCounts.tags` into `content`'s
 * `liveFound` would compare a raw per-row connector count against a `PhaseReport.found` that never
 * counted either of them at all — not an off-by-one, a completely different quantity.
 *
 * `navigation` is `undefined` for a related but distinct reason: `phases/content.ts`'s `navigation`
 * entity *does* read every `connector.navigation()` row now (via `extractNavigation`, Task 741) — this
 * is no longer "nothing reads it yet" the way it was before Task 13. But that entity is a one-record
 * sentinel (`{ key: 'site-navigation' }`) whose `classify` drains the real navigation rows internally
 * and always reports exactly 1 to `readEntity()`'s count, regardless of how many navigation rows the
 * source actually has (`report.ts`'s own doc comment on this). There is therefore still no 1:1
 * `VerifyEntity` count to compare against `PhaseReport.found` for it — its constant contribution is
 * handled separately, via `PHASE_FOUND_SENTINEL_OFFSET` below, not by owning `navigation` here. */
export const ENTITY_OWNING_PHASE: Record<VerifyEntity, MigrationPhaseId | undefined> = {
  users: 'users',
  groups: 'users',
  pages: 'content',
  pageHistory: undefined,
  tags: undefined,
  assets: 'assets',
  navigation: undefined
}

/** Constant amount to add to a phase's summed `ENTITY_OWNING_PHASE`-owned live counts before comparing
 * against its captured dry-run `PhaseReport.found` — for a phase-level sentinel record that
 * `readEntity()` counts but that has no corresponding `VerifyEntity` of its own (see
 * `ENTITY_OWNING_PHASE`'s doc comment on `navigation`). `content` is the one case today: its
 * `site-navigation` sentinel always contributes exactly 1 to `found`. Without this offset,
 * `compareAgainstDryRunReports` reports a spurious mismatch on every real content-phase run, purely
 * from this constant, not a real data problem. */
const PHASE_FOUND_SENTINEL_OFFSET: Partial<Record<MigrationPhaseId, number>> = {
  content: 1
}

/**
 * Two more entities land in a phase's real `PhaseReport.found`, that — unlike `navigation`'s constant
 * sentinel above — genuinely vary per run and so cannot be handled as a fixed offset:
 *
 * - `userGroups`: the `users` phase's third entity (`phases/users.ts`, `dependsOn: ['groups', 'users']`
 *   implicitly via strict entity-drain order), one record per source membership — derived the exact same
 *   way that entity's own `source` does, `deriveUserGroupsFromEmbeddedGroups(source.users())` re-
 *   expanding each user row's embedded `groups: [{id, name}]` array. There is no `SourceConnector
 *   .userGroups()` method to read this off directly (see that function's own doc comment) and no
 *   `VerifyEntity` for it either — `ENTITY_OWNING_PHASE` only accounts for `users`+`groups`, so a real
 *   `users`-phase `PhaseReport.found` (`groups + users + userGroups`) was undercounted by exactly the
 *   membership count on every source where any user belongs to any group, which is effectively always.
 * - `comments`: the `assets` phase's second entity, read directly off `SourceConnector.comments()` — a
 *   real generator since Task 16 built a write path for it, but never added to `VERIFY_ENTITIES` (see
 *   that array's own doc comment: record-count reconciliation and this phase-found comparison are
 *   different concerns). A real `assets`-phase `PhaseReport.found` (`assets + comments`) was
 *   undercounted by the comment count on every source with at least one comment.
 *
 * `countPhaseOnlySourceCounts()` computes both once per verify run, the same way `countSourceEntities()`
 * computes `SourceEntityCounts` once — `compareAgainstDryRunReports()` takes the result as a second
 * input rather than re-deriving it, so it stays a pure function of already-computed counts.
 */
export interface PhaseOnlySourceCounts {
  userGroups: number | 'not_implemented'
  comments: number | 'not_implemented'
}

const PHASE_ONLY_SOURCE_OWNING_PHASE: Record<keyof PhaseOnlySourceCounts, MigrationPhaseId> = {
  userGroups: 'users',
  comments: 'assets'
}

/** A source-side count, or `'not_implemented'` when that entity's generator is still a
 * `NotYetImplementedError` stub. */
export type SourceEntityCounts = Record<VerifyEntity, number | 'not_implemented'>

async function countAsyncIterable(iterable: AsyncIterable<unknown>): Promise<number> {
  let count = 0
  for await (const _record of iterable) {
    count++
  }
  return count
}

/** Counts one source entity's records, resolving to `'not_implemented'` rather than aborting the whole
 * verify run when the generator is still a stub. A `NotYetImplementedError` is caught whether thrown
 * synchronously as the generator method is called or from inside the async iteration itself — both are
 * real shapes across the two connectors. */
async function countOrNotImplemented(
  body: () => AsyncIterable<unknown>
): Promise<number | 'not_implemented'> {
  try {
    return await countAsyncIterable(body())
  } catch (err: any) {
    if (err instanceof NotYetImplementedError) {
      return 'not_implemented'
    }
    throw err
  }
}

/**
 * Counts the two phase-report entities `VERIFY_ENTITIES`/`countSourceEntities()` do not cover — see
 * `PhaseOnlySourceCounts`'s own doc comment for why each needs its own derivation. `userGroups` reads
 * `source.users()` a second time (once here, once inside `countSourceEntities()`'s own `users` count) —
 * the same accepted "two full reads of `users`" tradeoff `phases/users.ts`'s own `userGroups` entity
 * makes, since this table is never in the same volume class as `pages`/`assetData`.
 */
export async function countPhaseOnlySourceCounts(
  source: SourceConnector
): Promise<PhaseOnlySourceCounts> {
  return {
    userGroups: await countOrNotImplemented(() =>
      deriveUserGroupsFromEmbeddedGroups(source.users())
    ),
    comments: await countOrNotImplemented(() => source.comments())
  }
}

/**
 * Counts every record `source` reports for each of `VERIFY_ENTITIES`, exhausting each generator in
 * turn. A generator that is still a stub resolves to `'not_implemented'` for that entity rather than
 * aborting the rest — mirrors `phases/define-phase.ts`'s `readEntity`, which this deliberately does not
 * import: that helper also drives dry-run classification this module has no need for.
 */
export async function countSourceEntities(source: SourceConnector): Promise<SourceEntityCounts> {
  const result = {} as SourceEntityCounts
  for (const entity of VERIFY_ENTITIES) {
    result[entity] = await countOrNotImplemented(() => source[entity]() as AsyncIterable<unknown>)
  }
  return result
}

// ----------------------------------------
// Destination counts
// ----------------------------------------

export type DestinationEntityCounts = Record<VerifyEntity, number>

/** Counts each entity type at the 3.0 destination, scoped to one site — `users`/`groups` are 3.0
 * global tables (no `siteId` column at all, see `db/schema.ts`), so `siteId` is accepted for every
 * entity for a uniform call shape but is only actually applied as a filter where the table has the
 * column. */
export interface DestinationCounter {
  users(siteId: string): Promise<number>
  groups(siteId: string): Promise<number>
  pages(siteId: string): Promise<number>
  pageHistory(siteId: string): Promise<number>
  tags(siteId: string): Promise<number>
  assets(siteId: string): Promise<number>
  /** Sum of `navigation.items.length` across every navigation row for the site — "entries" per the
   * task description, not "menus". Top-level items only: a nested `NavigationItem.children` entry is
   * not flattened in, matching how the source connector's own doc describes `navigation()` as one
   * entry per row/expanded key, not a recursive walk. */
  navigation(siteId: string): Promise<number>
}

/** Builds the real, `WikiDb`-backed `DestinationCounter`. A test builds its own fake implementing this
 * same interface instead of standing up a database — same pattern `phases.test.ts`'s fake
 * `SourceConnector` already uses in this codebase. */
export function createDestinationCounter(db: WikiDb): DestinationCounter {
  return {
    async users() {
      // Global table, no siteId column — see the interface doc above.
      return db.$count(users)
    },
    async groups() {
      return db.$count(groups)
    },
    async pages(siteId) {
      return db.$count(pages, eq(pages.siteId, siteId))
    },
    async pageHistory(siteId) {
      return db.$count(pageHistory, eq(pageHistory.siteId, siteId))
    },
    // -> The `tags` table (`db/schema.ts`) is a dead leftover nothing in `backend/` ever writes to
    //    (see `models/tags.ts`'s own doc comment) — the real tag list lives in `pages.tags`, so the
    //    destination count is derived the same way `models/tags.ts#getTags` derives it: DISTINCT tags
    //    unnested across the site's pages.
    async tags(siteId) {
      const result = await db.execute(sql`
        SELECT COUNT(DISTINCT tag)::int AS count
        FROM pages, unnest(tags) AS tag
        WHERE "siteId" = ${siteId}
      `)
      const rows = (result.rows ?? result) as { count: number }[]
      return rows[0]?.count ?? 0
    },
    async assets(siteId) {
      return db.$count(assets, eq(assets.siteId, siteId))
    },
    async navigation(siteId) {
      const rows = await db
        .select({ items: navigation.items })
        .from(navigation)
        .where(eq(navigation.siteId, siteId))
      return rows.reduce((sum, row) => sum + (Array.isArray(row.items) ? row.items.length : 0), 0)
    }
  }
}

/** Runs every `DestinationCounter` method for `siteId` and packages the results the same shape
 * `countSourceEntities` returns, so the two are directly comparable. */
export async function countDestinationEntities(
  counter: DestinationCounter,
  siteId: string
): Promise<DestinationEntityCounts> {
  const result = {} as DestinationEntityCounts
  for (const entity of VERIFY_ENTITIES) {
    result[entity] = await counter[entity](siteId)
  }
  return result
}

// ----------------------------------------
// Reconciliation
// ----------------------------------------

export type EntityCountStatus = 'match' | 'mismatch' | 'source_not_implemented'

export interface EntityCount {
  entity: VerifyEntity
  sourceCount: number | null
  destinationCount: number
  status: EntityCountStatus
}

/** Per-entity expected `destinationCount - sourceCount`, accounting for rows the importer
 * deliberately does not carry over one-to-one rather than treating every such case as a mismatch.
 * `groups` is the one nonzero case: 3.0 seeds three system groups — Administrators, Users, Guests
 * (`models/groups.ts:404,422,440`) — against 2.x's two (Administrators id 1, Guests id 2), both of
 * which the importer skips as `isSystem` (`importers/users-groups.ts:798,870`), so a flawless import
 * always lands the destination exactly one group above the source. `users` deliberately stays 0: 3.0's
 * own seeded admin (`isSystem: false`) and Guest (`isSystem: true`, `models/users.ts:1535,1553-1556`)
 * net out against 2.x's two skipped system users on a fresh single-site import, so giving it a nonzero
 * delta (or filtering destination system rows instead) would break that currently-matching case. */
const EXPECTED_COUNT_DELTA: Record<VerifyEntity, number> = {
  users: 0,
  groups: 1,
  pages: 0,
  pageHistory: 0,
  tags: 0,
  assets: 0,
  navigation: 0
}

/** Per-entity source-vs-destination reconciliation — task 748's first check. A `'not_implemented'`
 * source count is reported as-is rather than as a mismatch: there is nothing to compare against yet,
 * and calling that a failure would make every run against an `ExportBundleSourceConnector` source fail
 * on `users`/`groups`/`assets` alone (still stubs there — see the module doc comment), which is not a
 * real data problem. A match requires `destinationCount - sourceCount` to equal that entity's
 * `EXPECTED_COUNT_DELTA`, not
 * bare equality — see its doc comment for why `groups` alone expects a nonzero difference. */
export function compareEntityCounts(
  sourceCounts: SourceEntityCounts,
  destinationCounts: DestinationEntityCounts
): EntityCount[] {
  return VERIFY_ENTITIES.map((entity) => {
    const sourceCount = sourceCounts[entity]
    const destinationCount = destinationCounts[entity]
    if (sourceCount === 'not_implemented') {
      return { entity, sourceCount: null, destinationCount, status: 'source_not_implemented' }
    }
    return {
      entity,
      sourceCount,
      destinationCount,
      status: destinationCount - sourceCount === EXPECTED_COUNT_DELTA[entity] ? 'match' : 'mismatch'
    }
  })
}

export type PhaseComparisonStatus = 'match' | 'mismatch' | 'live_not_implemented' | 'no_report'

export interface PhaseReportComparison {
  phase: MigrationPhaseId
  /** `PhaseReport.found` from the captured dry-run report, summed if more than one report line names
   * the same phase (should not happen in practice — `runMigration` never runs a phase twice — but
   * summing rather than taking the last is the safer default for a hand-edited or concatenated file). */
  reportFound: number
  /** Sum of the live source counts for every entity this phase owns (`ENTITY_OWNING_PHASE`), plus that
   * phase's `PHASE_FOUND_SENTINEL_OFFSET` if any, or `null` if any owned entity is still
   * `'not_implemented'` — a phase's `PhaseReport.found` is one aggregate number across all its
   * entities (and sentinels), so a genuine per-entity comparison against it is not possible; this is
   * the closest apples-to-apples total. */
  liveFound: number | null
  status: PhaseComparisonStatus
}

/**
 * Cross-checks each phase's live entity totals against what a previously captured dry-run report
 * (`--report-file`, task 744) said it found — task 748's "surfacing any discrepancy against the
 * dry-run report captured before the run". Deliberately phase-level, not entity-level: `PhaseReport`
 * only carries one `found` total per phase (e.g. the `content` phase's `found` is its `pages` entity's
 * count plus its `site-navigation` sentinel's constant 1 — see `ENTITY_OWNING_PHASE`'s and
 * `PHASE_FOUND_SENTINEL_OFFSET`'s doc comments — not `pages` + `pageHistory` + `tags`, which is what
 * this compared before Task 13's content-staging rewrite folded both of those into `pages`), so that is
 * the finest grain this comparison can honestly make.
 *
 * `phaseOnlyCounts` folds in `userGroups`/`comments` (whole-branch review Critical #2 fix) — real,
 * run-varying counts `ENTITY_OWNING_PHASE`/`VERIFY_ENTITIES` cannot express, unlike
 * `PHASE_FOUND_SENTINEL_OFFSET`'s fixed constant. Without this, the `users` phase's `liveFound` (just
 * `groups + users`) undercounted a real `PhaseReport.found` (`groups + users + userGroups`) by exactly
 * the membership count on essentially every real source, and the `assets` phase's `liveFound` (just
 * `assets`) undercounted its own real `found` (`assets + comments`) by the comment count on any source
 * with at least one — both reported as a spurious `'mismatch'`, not a real data problem. See
 * `PhaseOnlySourceCounts`'s own doc comment for the full trace.
 */
export function compareAgainstDryRunReports(
  sourceCounts: SourceEntityCounts,
  phaseOnlyCounts: PhaseOnlySourceCounts,
  dryRunReports: PhaseReport[]
): PhaseReportComparison[] {
  const phasesWithEntities = new Set(
    Object.values(ENTITY_OWNING_PHASE).filter((phase): phase is MigrationPhaseId => Boolean(phase))
  )
  for (const phase of Object.keys(PHASE_FOUND_SENTINEL_OFFSET) as MigrationPhaseId[]) {
    phasesWithEntities.add(phase)
  }
  for (const phase of Object.values(PHASE_ONLY_SOURCE_OWNING_PHASE)) {
    phasesWithEntities.add(phase)
  }

  return [...phasesWithEntities].map((phase) => {
    const reportsForPhase = dryRunReports.filter((report) => report.phase === phase)
    const ownedEntities = VERIFY_ENTITIES.filter((entity) => ENTITY_OWNING_PHASE[entity] === phase)
    const phaseOnlyKeys = (
      Object.keys(PHASE_ONLY_SOURCE_OWNING_PHASE) as (keyof PhaseOnlySourceCounts)[]
    ).filter((key) => PHASE_ONLY_SOURCE_OWNING_PHASE[key] === phase)
    const ownedCounts: (number | 'not_implemented')[] = [
      ...ownedEntities.map((entity) => sourceCounts[entity]),
      ...phaseOnlyKeys.map((key) => phaseOnlyCounts[key])
    ]
    const sentinelOffset = PHASE_FOUND_SENTINEL_OFFSET[phase] ?? 0
    const liveFound = ownedCounts.some((count) => count === 'not_implemented')
      ? null
      : (ownedCounts as number[]).reduce((sum, count) => sum + count, 0) + sentinelOffset

    if (reportsForPhase.length === 0) {
      return { phase, reportFound: 0, liveFound, status: 'no_report' }
    }
    const reportFound = reportsForPhase.reduce((sum, report) => sum + report.found, 0)
    if (liveFound === null) {
      return { phase, reportFound, liveFound, status: 'live_not_implemented' }
    }
    return {
      phase,
      reportFound,
      liveFound,
      status: reportFound === liveFound ? 'match' : 'mismatch'
    }
  })
}

// ----------------------------------------
// Content-integrity spot-check
// ----------------------------------------

/** SHA-256 of the given text, treating `null`/`undefined` as empty — a page with no content yet and a
 * page whose content is genuinely `''` hash identically, which is the right call here: this check is
 * about whether two present bodies match, not about presence itself (a missing page is its own
 * `'source_missing'`/`'destination_missing'` status below). */
export function hashContent(content: string | null | undefined): string {
  return createHash('sha256')
    .update(content ?? '')
    .digest('hex')
}

/**
 * Reservoir sampling (Algorithm R): picks exactly `min(size, itemCount)` items uniformly at random
 * from a stream of unknown length in one pass, without buffering the whole stream — the content
 * spot-check's default mode reads a live `AsyncIterable<SourceRecord>` this way rather than collecting
 * every page just to throw most of them away.
 */
export class ReservoirSampler<T> {
  private readonly size: number
  private readonly rng: () => number
  private readonly reservoir: T[] = []
  private seen = 0

  constructor(size: number, rng: () => number = Math.random) {
    this.size = size
    this.rng = rng
  }

  offer(item: T): void {
    this.seen++
    if (this.reservoir.length < this.size) {
      this.reservoir.push(item)
      return
    }
    const replaceAt = Math.floor(this.rng() * this.seen)
    if (replaceAt < this.size) {
      this.reservoir[replaceAt] = item
    }
  }

  result(): T[] {
    return [...this.reservoir]
  }
}

export type SpotCheckStatus =
  | 'match'
  | 'mismatch'
  | 'source_missing'
  | 'destination_missing'
  | 'source_not_implemented'

export interface SpotCheckEntry {
  /** The 2.x source path, unnormalized — what a caller passed via `--sample-paths` or what the
   * source reported, not the folded 3.0 tree path actually used to look up the destination row (see
   * `runContentSpotCheck`). */
  path: string
  status: SpotCheckStatus
  /** Both hashes are of `pages.content` (the raw, unrendered body `createPage` stores verbatim) on
   * their respective side — never `pages.render`, which 3.0's `rendering.postProcess` derives
   * through sanitization/cheerio/icon-handling and so is never byte-identical to the 2.x source's own
   * `render`, even for a page that imported perfectly. */
  sourceHash?: string
  destinationHash?: string
}

export interface SpotCheckOptions {
  siteId: string
  /** Explicit paths to check instead of a random sample — `--sample-paths`. Takes priority over
   * `sampleSize` when given, per the task description ("or a specific list via --sample-paths"). */
  paths?: string[]
  /** Random sample size when `paths` is not given. Defaults to 20 per the task description. */
  sampleSize?: number
  /** Injectable RNG for `ReservoirSampler`, defaulting to `Math.random` — a test passes a seeded
   * generator for a deterministic sample instead of asserting on `Math.random`'s real output. */
  rng?: () => number
}

/** Looks up one destination page's stored body by the natural key an importer would key on (`siteId`,
 * `locale`, `path` — the same key `phases/content.ts`'s `existingEntry` checks against
 * `WIKI.models.tree.getEntryAt()`; `path` is the already-normalized 3.0 tree path, not the raw 2.x one
 * — see `runContentSpotCheck`). Returns `undefined` when no such page exists at the destination. */
export type DestinationPageLookup = (
  siteId: string,
  locale: string,
  path: string
) => Promise<{ content: string | null } | undefined>

/** Builds the real, `WikiDb`-backed `DestinationPageLookup`. Reads `pages.content`, not
 * `pages.render` — `createPage` (`models/pages.ts`) stores `content` verbatim from the import input,
 * while `render` is derived by `rendering.postProcess` (sanitize, cheerio, `stripEditorArtifacts`,
 * icon handling, `anchorHeadings`, re-serialize) and so is never a faithful copy of anything on the
 * 2.x side. */
export function createDestinationPageLookup(db: WikiDb): DestinationPageLookup {
  return async (siteId, locale, path) => {
    const [row] = await db
      .select({ content: pages.content })
      .from(pages)
      .where(and(eq(pages.siteId, siteId), eq(pages.locale, locale), eq(pages.path, path)))
      .limit(1)
    return row
  }
}

function pagePath(record: SourceRecord): string | undefined {
  return typeof record.path === 'string' ? record.path : undefined
}

/** Normalizes a raw 2.x source path into the 3.0 tree path an import would have actually placed it
 * at — the same `normalizeMigratedPath` fold (lowercase, `_` → `-`) `page-import.ts` applies to
 * every imported page. Returns `undefined` when the path doesn't normalize to anything valid (in
 * which case the page was never importable in the first place, so there is nothing to look up). */
function destinationLookupPath(rawPath: string): string | undefined {
  const normalized = normalizeMigratedPath(rawPath)
  return 'reason' in normalized ? undefined : normalized.path
}

function pageLocale(record: SourceRecord): string {
  return typeof record.localeCode === 'string' ? record.localeCode : 'en'
}

function pageContent(record: SourceRecord): string | null {
  return typeof record.content === 'string' ? record.content : null
}

/**
 * Runs the content-integrity spot-check: for each sampled source page, hash-compares its raw body
 * (2.x `pages.content`, which 3.0's `createPage` stores verbatim into `pages.content` — see
 * `SpotCheckEntry`'s doc for why this is `content` and not `render`) against the destination page's
 * own stored `content`, to catch truncation or encoding corruption a plain row-count match cannot
 * reveal. The destination lookup uses the path *after* running it through the same
 * `normalizeMigratedPath` fold every import applies (`path-normalization.ts`) — the raw 2.x `path`
 * looked up unnormalized would miss any page whose path had an uppercase letter or an underscore,
 * since those are exactly what the fold rewrites before the page is ever written to the 3.0 tree.
 *
 * When `options.paths` is given, this reads every source page once, picks out exactly those paths (a
 * miss is reported as `'source_missing'`), and reports a synthetic path for any explicitly-requested
 * path never found. Otherwise it reservoir-samples `options.sampleSize` (default 20) pages uniformly
 * at random while reading the source exactly once.
 *
 * `source.pages()` being a `NotYetImplementedError` stub — real against both connectors today, but a
 * theoretical concern for any future `SourceConnector` implementation this module has no visibility
 * into — reports as a single `'source_not_implemented'` entry rather than throwing, the same honest,
 * non-crashing pattern the rest of this module and `phases/define-phase.ts` follow.
 */
export async function runContentSpotCheck(
  source: SourceConnector,
  lookupDestination: DestinationPageLookup,
  options: SpotCheckOptions
): Promise<SpotCheckEntry[]> {
  const requestedPaths = options.paths?.length ? options.paths : undefined
  const requestedPathSet = requestedPaths ? new Set(requestedPaths) : undefined
  const sampler = requestedPaths
    ? undefined
    : new ReservoirSampler<SourceRecord>(
        options.sampleSize && options.sampleSize > 0 ? options.sampleSize : 20,
        options.rng
      )
  const foundByPath = new Map<string, SourceRecord>()

  try {
    for await (const record of source.pages()) {
      const page = record as SourceRecord
      if (requestedPathSet) {
        const path = pagePath(page)
        if (path && requestedPathSet.has(path)) {
          foundByPath.set(path, page)
        }
      } else {
        sampler!.offer(page)
      }
    }
  } catch (err: any) {
    if (err instanceof NotYetImplementedError) {
      return [{ path: '(all pages)', status: 'source_not_implemented' }]
    }
    throw err
  }

  const sampled: { path: string; record: SourceRecord | undefined }[] = requestedPaths
    ? requestedPaths.map((path) => ({ path, record: foundByPath.get(path) }))
    : sampler!.result().map((record) => ({ path: pagePath(record) ?? '(unknown path)', record }))

  const entries: SpotCheckEntry[] = []
  for (const { path, record } of sampled) {
    if (!record) {
      entries.push({ path, status: 'source_missing' })
      continue
    }
    const locale = pageLocale(record)
    const lookupPath = destinationLookupPath(path)
    const destination =
      lookupPath === undefined
        ? undefined
        : await lookupDestination(options.siteId, locale, lookupPath)
    if (!destination) {
      entries.push({ path, status: 'destination_missing' })
      continue
    }
    const sourceHash = hashContent(pageContent(record))
    const destinationHash = hashContent(destination.content)
    entries.push({
      path,
      status: sourceHash === destinationHash ? 'match' : 'mismatch',
      sourceHash,
      destinationHash
    })
  }
  return entries
}

// ----------------------------------------
// Pass/fail summary
// ----------------------------------------

export type VerifyOutcome = 'pass' | 'incomplete' | 'fail'

export interface VerifySummaryInput {
  entityCounts: EntityCount[]
  phaseComparisons: PhaseReportComparison[]
  spotCheck: SpotCheckEntry[]
}

export interface VerifySummary {
  outcome: VerifyOutcome
  text: string
}

function outcomeOf(
  entityCounts: EntityCount[],
  phaseComparisons: PhaseReportComparison[],
  spotCheck: SpotCheckEntry[]
): VerifyOutcome {
  const hasMismatch =
    entityCounts.some((c) => c.status === 'mismatch') ||
    phaseComparisons.some((c) => c.status === 'mismatch') ||
    spotCheck.some(
      (s) =>
        s.status === 'mismatch' ||
        s.status === 'source_missing' ||
        s.status === 'destination_missing'
    )
  if (hasMismatch) {
    return 'fail'
  }
  const hasIncomplete =
    entityCounts.some((c) => c.status === 'source_not_implemented') ||
    phaseComparisons.some((c) => c.status === 'live_not_implemented' || c.status === 'no_report') ||
    spotCheck.some((s) => s.status === 'source_not_implemented')
  return hasIncomplete ? 'incomplete' : 'pass'
}

/**
 * Renders the pass/fail summary — plain text, meant to be pasted directly into the cutover runbook's
 * verification step (task 751). `'incomplete'` (distinct from `'fail'`) covers every entity/phase/page
 * whose source generator is still a stub: today that is everything, honestly, until Features
 * 414/416/418/420 land — this is not a failure of the migration, it is "nothing to verify yet".
 */
export function formatVerifySummary(input: VerifySummaryInput): VerifySummary {
  const { entityCounts, phaseComparisons, spotCheck } = input
  const outcome = outcomeOf(entityCounts, phaseComparisons, spotCheck)

  const lines: string[] = []
  lines.push('Wiki.js 2.5.x -> 3.0 migration verification')
  lines.push('='.repeat(44))
  lines.push(`Overall: ${outcome.toUpperCase()}`)
  lines.push('')
  lines.push('Record counts (source vs. destination)')
  lines.push('-'.repeat(44))
  for (const c of entityCounts) {
    const src = c.sourceCount === null ? 'not implemented' : String(c.sourceCount)
    lines.push(
      `  [${statusMark(c.status)}] ${c.entity}: source=${src} destination=${c.destinationCount}`
    )
  }
  lines.push('')
  lines.push('Vs. captured dry-run report')
  lines.push('-'.repeat(44))
  if (phaseComparisons.every((c) => c.status === 'no_report')) {
    lines.push('  (no --against-report given, or no matching phase found in it)')
  } else {
    for (const c of phaseComparisons) {
      const live = c.liveFound === null ? 'not implemented' : String(c.liveFound)
      lines.push(
        `  [${statusMark(c.status)}] ${c.phase}: dry-run found=${c.reportFound} live found=${live}`
      )
    }
  }
  lines.push('')
  lines.push(`Content spot-check (${spotCheck.length} page(s))`)
  lines.push('-'.repeat(44))
  for (const s of spotCheck) {
    lines.push(`  [${statusMark(s.status)}] ${s.path}: ${s.status}`)
  }

  return { outcome, text: lines.join('\n') }
}

function statusMark(status: EntityCountStatus | PhaseComparisonStatus | SpotCheckStatus): string {
  switch (status) {
    case 'match':
      return 'PASS'
    case 'mismatch':
    case 'source_missing':
    case 'destination_missing':
      return 'FAIL'
    default:
      return 'SKIP'
  }
}
