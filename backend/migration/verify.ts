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
 *    source's rendered body against the destination's, to catch truncation/encoding corruption that a
 *    row-count match alone would never reveal (a page that imported "successfully" but with its body
 *    cut off half way through still counts as 1 row either side).
 *
 * Every entity generator this reads through `SourceConnector` is, as of this task, still a
 * `NotYetImplementedError` stub (Features 414/416/418/420 own implementing them) — exactly the same
 * situation task 744's dry-run mode and task 746's provenance tracking were built against. This module
 * follows the same honest pattern established there: a `NotYetImplementedError` is caught and reported
 * as `'not_implemented'` for that entity rather than crashing the whole verification run, so this is
 * genuinely runnable and testable today, and starts reporting real numbers the moment each Feature
 * lands — no changes needed here when that happens.
 */

import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { assets, groups, navigation, pageHistory, pages, tags, users } from '../db/schema.ts'
import { NotYetImplementedError } from './connector.ts'
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

/** Which current `MigrationPhase` (see `phases/index.ts`) reads a given entity, when any does — this
 * is what lets a live count be cross-checked against a captured dry-run `PhaseReport`. `undefined`
 * means no phase currently owns it (`navigation`: the `settings` phase reads `settings()` only, not
 * `navigation()`, until Task 420 wires it up). */
export const ENTITY_OWNING_PHASE: Record<VerifyEntity, MigrationPhaseId | undefined> = {
  users: 'users',
  groups: 'users',
  pages: 'content',
  pageHistory: 'content',
  tags: 'content',
  assets: 'assets',
  navigation: undefined
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

/**
 * Counts every record `source` reports for each of `VERIFY_ENTITIES`, exhausting each generator in
 * turn. A generator that is still a stub resolves to `'not_implemented'` for that entity rather than
 * aborting the rest — mirrors `phases/define-phase.ts`'s `readEntity`, which this deliberately does not
 * import: that helper also drives dry-run classification this module has no need for.
 */
export async function countSourceEntities(source: SourceConnector): Promise<SourceEntityCounts> {
  const result = {} as SourceEntityCounts
  for (const entity of VERIFY_ENTITIES) {
    try {
      result[entity] = await countAsyncIterable(source[entity]() as AsyncIterable<unknown>)
    } catch (err: any) {
      if (err instanceof NotYetImplementedError) {
        result[entity] = 'not_implemented'
      } else {
        throw err
      }
    }
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
 * same interface instead of standing up a database — same pattern `provenance.ts`'s `ProvenanceStore`
 * and `phases.test.ts`'s fake `SourceConnector` already use in this codebase. */
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
    async tags(siteId) {
      return db.$count(tags, eq(tags.siteId, siteId))
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
 * and calling that a failure would make every run fail until Features 414/416/418/420 all land. A
 * match requires `destinationCount - sourceCount` to equal that entity's `EXPECTED_COUNT_DELTA`, not
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
  /** Sum of the live source counts for every entity this phase owns (`ENTITY_OWNING_PHASE`), or `null`
   * if any of them is still `'not_implemented'` — a phase's `PhaseReport.found` is one aggregate
   * number across all its entities, so a genuine per-entity comparison against it is not possible; this
   * is the closest apples-to-apples total. */
  liveFound: number | null
  status: PhaseComparisonStatus
}

/**
 * Cross-checks each phase's live entity totals against what a previously captured dry-run report
 * (`--report-file`, task 744) said it found — task 748's "surfacing any discrepancy against the
 * dry-run report captured before the run". Deliberately phase-level, not entity-level: `PhaseReport`
 * only carries one `found` total per phase (e.g. the `content` phase's `found` is `pages` + `pageHistory`
 * + `tags` combined), so that is the finest grain this comparison can honestly make.
 */
export function compareAgainstDryRunReports(
  sourceCounts: SourceEntityCounts,
  dryRunReports: PhaseReport[]
): PhaseReportComparison[] {
  const phasesWithEntities = new Set(
    Object.values(ENTITY_OWNING_PHASE).filter((phase): phase is MigrationPhaseId => Boolean(phase))
  )

  return [...phasesWithEntities].map((phase) => {
    const reportsForPhase = dryRunReports.filter((report) => report.phase === phase)
    const ownedEntities = VERIFY_ENTITIES.filter((entity) => ENTITY_OWNING_PHASE[entity] === phase)
    const ownedCounts = ownedEntities.map((entity) => sourceCounts[entity])
    const liveFound = ownedCounts.some((count) => count === 'not_implemented')
      ? null
      : (ownedCounts as number[]).reduce((sum, count) => sum + count, 0)

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

/** SHA-256 of the given text, treating `null`/`undefined` as empty — a page with no render yet and a
 * page whose render is genuinely `''` hash identically, which is the right call here: this check is
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
  path: string
  status: SpotCheckStatus
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

/** Looks up one destination page's rendered body by the natural key an importer would key on
 * (`siteId`, `locale`, `path` — same as `provenance.ts`'s `findExistingPageByPath`). Returns
 * `undefined` when no such page exists at the destination. */
export type DestinationPageLookup = (
  siteId: string,
  locale: string,
  path: string
) => Promise<{ render: string | null } | undefined>

/** Builds the real, `WikiDb`-backed `DestinationPageLookup`. */
export function createDestinationPageLookup(db: WikiDb): DestinationPageLookup {
  return async (siteId, locale, path) => {
    const [row] = await db
      .select({ render: pages.render })
      .from(pages)
      .where(and(eq(pages.siteId, siteId), eq(pages.locale, locale), eq(pages.path, path)))
      .limit(1)
    return row
  }
}

function pagePath(record: SourceRecord): string | undefined {
  return typeof record.path === 'string' ? record.path : undefined
}

function pageLocale(record: SourceRecord): string {
  return typeof record.localeCode === 'string' ? record.localeCode : 'en'
}

function pageRender(record: SourceRecord): string | null {
  return typeof record.render === 'string' ? record.render : null
}

/**
 * Runs the content-integrity spot-check: for each sampled source page, hash-compares its rendered
 * body (2.x `pages.render` — maps directly onto 3.0 `pages.render` per
 * `docs/migration/2.5x-to-3.0-mapping.md`'s pages table) against the destination page's own `render`,
 * to catch truncation or encoding corruption a plain row-count match cannot reveal.
 *
 * When `options.paths` is given, this reads every source page once, picks out exactly those paths (a
 * miss is reported as `'source_missing'`), and reports a synthetic path for any explicitly-requested
 * path never found. Otherwise it reservoir-samples `options.sampleSize` (default 20) pages uniformly
 * at random while reading the source exactly once.
 *
 * `source.pages()` still being a `NotYetImplementedError` stub (true for both connectors as of this
 * task) reports as a single `'source_not_implemented'` entry rather than throwing — the same honest,
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
    const destination = await lookupDestination(options.siteId, locale, path)
    if (!destination) {
      entries.push({ path, status: 'destination_missing' })
      continue
    }
    const sourceHash = hashContent(pageRender(record))
    const destinationHash = hashContent(destination.render)
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
