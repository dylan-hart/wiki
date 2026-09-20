/**
 * Post-import verification. Two independent checks, both meant to run after a real (non-dry-run)
 * migration:
 *
 * 1. **Record-count reconciliation**: source vs. 3.0 destination per entity, plus — where a dry-run
 *    report was captured with `--report-file` — the live totals against what that report predicted
 *    per phase. The latter is the stronger signal: a bare source-vs-destination mismatch can simply
 *    mean the source changed between the two runs.
 * 2. **Content-integrity spot-check**: hash-compare a sample of pages' raw source bodies against the
 *    destination's stored `pages.content`, catching the truncation or encoding corruption a row
 *    count cannot see. `content`, never `render`: `createPage()` recomputes the render via
 *    `CARDINAL.models.rendering.postProcess()`, so a render-vs-render hash would mismatch on
 *    essentially every real page; `content` is the one field it stores unmodified.
 *
 * `ExportBundleSourceConnector` stubs most entity generators out with `NotYetImplementedError`. That
 * is caught and reported as `'not_implemented'` for the entity rather than aborting, so a verify run
 * against a bundle source still reports on whatever it can read.
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

/** `navigation` is here despite owning no phase entity: the two row counts are still comparable. */
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

/** Which phase reads an entity as a dedicated, 1:1-countable `PhaseEntity`, which is what makes a
 * live count comparable to a captured dry-run `PhaseReport.found`. `undefined` means no phase owns it
 * *that way*, and mapping such an entity to a phase anyway would compare two different quantities:
 *
 * - `pageHistory`/`tags`: `phases/content.ts` merges both into `StagedPage`, so no separate
 *   `readEntity()` count for either exists to be part of `content`'s `found`.
 * - `navigation`: the phase's `navigation` entity is a one-record sentinel whose `classify` drains
 *   the real rows internally and always reports exactly 1. That constant is handled by
 *   `PHASE_FOUND_SENTINEL_OFFSET` instead. */
export const ENTITY_OWNING_PHASE: Record<VerifyEntity, MigrationPhaseId | undefined> = {
  users: 'users',
  groups: 'users',
  pages: 'content',
  pageHistory: undefined,
  tags: undefined,
  assets: 'assets',
  navigation: undefined
}

/** Added to a phase's summed live counts before comparing against `PhaseReport.found`, for a sentinel
 * record `readEntity()` counts but that has no `VerifyEntity`. Without it every content-phase run
 * reports a spurious mismatch off this constant alone. */
const PHASE_FOUND_SENTINEL_OFFSET: Partial<Record<MigrationPhaseId, number>> = {
  content: 1
}

/**
 * Two more entities count into a phase's `PhaseReport.found` that — unlike `navigation`'s sentinel —
 * vary per run and so cannot be a fixed offset, and that have no `VerifyEntity` of their own:
 * `userGroups` (the `users` phase's third entity, one record per source membership, with no
 * `SourceConnector.userGroups()` to read it off directly) and `comments` (the `assets` phase's
 * second entity). Omitting either undercounts that phase's `liveFound` on essentially every real
 * source, reported as a spurious mismatch.
 */
export interface PhaseOnlySourceCounts {
  userGroups: number | 'not_implemented'
  comments: number | 'not_implemented'
}

const PHASE_ONLY_SOURCE_OWNING_PHASE: Record<keyof PhaseOnlySourceCounts, MigrationPhaseId> = {
  userGroups: 'users',
  comments: 'assets'
}

export type SourceEntityCounts = Record<VerifyEntity, number | 'not_implemented'>

async function countAsyncIterable(iterable: AsyncIterable<unknown>): Promise<number> {
  let count = 0
  for await (const _record of iterable) {
    count++
  }
  return count
}

/** `body` is a thunk so a `NotYetImplementedError` is caught whether the generator method throws it
 * synchronously on the call or from inside the iteration — both shapes occur across the connectors. */
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
 * `userGroups` reads `source.users()` a second time (`countSourceEntities()` already read it once) —
 * the same accepted tradeoff `phases/users.ts` makes, since `users` is never in the volume class of
 * `pages`/`assetData`.
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
 * Mirrors `phases/define-phase.ts`'s `readEntity` rather than importing it: that helper also drives
 * dry-run classification, which verification has no use for.
 */
export async function countSourceEntities(source: SourceConnector): Promise<SourceEntityCounts> {
  const result = {} as SourceEntityCounts
  for (const entity of VERIFY_ENTITIES) {
    result[entity] = await countOrNotImplemented(() => source[entity]() as AsyncIterable<unknown>)
  }
  return result
}

export type DestinationEntityCounts = Record<VerifyEntity, number>

/** Every method takes `siteId` for a uniform call shape, but `users`/`groups` are global 3.0 tables
 * with no `siteId` column, so it is only applied as a filter where the table has one. */
export interface DestinationCounter {
  users(siteId: string): Promise<number>
  groups(siteId: string): Promise<number>
  pages(siteId: string): Promise<number>
  pageHistory(siteId: string): Promise<number>
  tags(siteId: string): Promise<number>
  assets(siteId: string): Promise<number>
  /** Counts entries, not menus: top-level `navigation.items` summed across the site's rows, with
   * nested `children` deliberately not flattened in, matching what `SourceConnector.navigation()`
   * yields. */
  navigation(siteId: string): Promise<number>
}

export function createDestinationCounter(db: WikiDb): DestinationCounter {
  return {
    async users() {
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
    // -> Nothing in `backend/` writes the `tags` table; the real tag list lives in `pages.tags`, so
    //    this derives the count the way `models/tags.ts#getTags` does.
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

export type EntityCountStatus = 'match' | 'mismatch' | 'source_not_implemented'

export interface EntityCount {
  entity: VerifyEntity
  sourceCount: number | null
  destinationCount: number
  status: EntityCountStatus
}

/** Expected `destinationCount - sourceCount` per entity, so a row the importer deliberately does not
 * carry one-to-one is not reported as a mismatch. `groups` is the one nonzero case: 3.0 seeds three
 * system groups against 2.x's two, both of which the importer skips as `isSystem`, so a flawless
 * import always lands exactly one group above the source. `users` stays 0 because 3.0's seeded admin
 * and Guest net out against 2.x's two skipped system users on a fresh single-site import. */
const EXPECTED_COUNT_DELTA: Record<VerifyEntity, number> = {
  users: 0,
  groups: 1,
  pages: 0,
  pageHistory: 0,
  tags: 0,
  assets: 0,
  navigation: 0
}

/** A `'not_implemented'` source count is reported as-is, not as a mismatch: nothing to compare is not
 * a data problem, and calling it a failure would fail every run against a bundle source outright. A
 * match is `destinationCount - sourceCount === EXPECTED_COUNT_DELTA[entity]`, not bare equality. */
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
  /** Summed when more than one report line names the same phase. `runMigration` never runs a phase
   * twice, but summing beats taking the last for a hand-edited or concatenated report file. */
  reportFound: number
  /** Live source counts for every entity the phase owns plus its `PHASE_FOUND_SENTINEL_OFFSET`, or
   * `null` if any owned entity is `'not_implemented'`. The closest apples-to-apples total there is:
   * `PhaseReport.found` is one aggregate across all of a phase's entities and sentinels. */
  liveFound: number | null
  status: PhaseComparisonStatus
}

/**
 * Phase-level, not entity-level: `PhaseReport` carries one `found` total per phase, so that is the
 * finest grain this comparison can honestly make. A pure function of already-computed counts —
 * `phaseOnlyCounts` is passed in rather than re-derived here.
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

/** `null`/`undefined` hashes as `''`: this check is about whether two present bodies match, and a
 * missing page is already its own `'source_missing'`/`'destination_missing'` status. */
export function hashContent(content: string | null | undefined): string {
  return createHash('sha256')
    .update(content ?? '')
    .digest('hex')
}

/**
 * Reservoir sampling (Algorithm R): exactly `min(size, itemCount)` items, uniformly at random, from
 * a stream of unknown length in one pass — so the spot-check never buffers every page just to throw
 * most of them away.
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
  /** The raw 2.x source path, not the folded 3.0 tree path the destination row was looked up by. */
  path: string
  status: SpotCheckStatus
  sourceHash?: string
  destinationHash?: string
}

export interface SpotCheckOptions {
  siteId: string
  /** Takes priority over `sampleSize` when given. */
  paths?: string[]
  sampleSize?: number
  /** Injectable so a test gets a deterministic sample instead of asserting on `Math.random`. */
  rng?: () => number
}

/** `path` must be the already-normalized 3.0 tree path, not the raw 2.x one. */
export type DestinationPageLookup = (
  siteId: string,
  locale: string,
  path: string
) => Promise<{ content: string | null } | undefined>

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

/** `undefined` when the path does not normalize to anything valid — such a page was never importable
 * in the first place, so there is nothing to look up. */
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
 * The destination lookup applies the same `normalizeMigratedPath` fold every import does: looked up
 * raw, any 2.x path carrying an uppercase letter or an underscore would miss, since those are
 * exactly what the fold rewrites before the page is written to the 3.0 tree.
 *
 * Either mode reads the source exactly once — `options.paths` picks those paths out of the stream,
 * otherwise a reservoir sample is built as it goes.
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
 * Plain text, meant to be pasted into the cutover runbook's verification step. `'incomplete'` is
 * distinct from `'fail'`: it covers every entity, phase or page whose source generator is a stub,
 * which is "nothing to verify yet", not a failed migration.
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
