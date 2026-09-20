import { isEqual } from 'es-toolkit/predicate'
import type { PageHistoryAction } from '../../models/pageHistory.ts'
import type {
  OrphanedPageHistoryEntry,
  StagedPage,
  StagedPageHistoryEntry
} from '../content-staging.ts'
import { derivePublishState, mapEditor } from './page-import.ts'

/**
 * `CARDINAL.models.pageHistory.record()` only ever snapshots the CURRENT `pages` row, so it cannot
 * express any of the *past* versions a 2.x page's history chain carries. This module is the
 * deliberate exception to "always go through the model": it reproduces by hand everything `record()`
 * would have computed (`meta`'s field set, `changedFields`'s diff, the action) and inserts
 * `pageHistory` rows directly.
 *
 * ## 2.x's `action` vocabulary is not 3.0's four
 *
 * Read off the 2.x source (`server/models/pages.js`, `server/graph/resolvers/page.js`):
 * `updatePage()`/`convertPage()` write `'updated'`, `movePage()` `'moved'`, `deletePage()`
 * `'deleted'`, and the GraphQL `restore` resolver `'restored'`. The column is free text, nullable,
 * and defaults to `'updated'`.
 *
 * **2.x never writes `'created'`**: `createPage()` never calls `addVersion()`, and since
 * `addVersion()` always snapshots pre-mutation state, a page's oldest history row already *is* the
 * page as created — only its action names the edit that followed. Nothing here synthesizes a
 * `'created'` row. 3.0, conversely, has no `'restored'` action — its restore flow is an ordinary
 * content `PATCH` — so `mapHistoryAction` folds that onto `'updated'`.
 *
 * ## Orphaned history (a `pageId` naming no current 2.x page)
 *
 * `pageHistory.pageId` is a non-FK plain column on both 2.x and 3.0 by design, so history outlives
 * the page it belonged to: every `models/pageHistory.ts` reader keys off `siteId`+`pageId` or
 * `siteId`+`locale`+`path` rather than joining back to `pages`. `backfillOrphanedPageHistory` gives
 * each `sourcePageOldId` group one synthesized UUID — one per group, not per row, so a deleted
 * page's whole chain shares a single `pageId` the way a live page's rows share its real id.
 */

export interface PageHistoryInsertRow {
  pageId: string
  siteId: string
  action: PageHistoryAction
  changedFields: string[]
  locale: string
  path: string
  title: string
  content: string | null
  meta: Record<string, unknown>
  reason: string | null
  versionDate: Date
  authorId: string | null
}

export interface PageHistoryImportDeps {
  /**
   * A bare `CARDINAL.db.insert(pageHistoryTable).values(rows)`, and nothing more. It must NOT call
   * `record()`, which discards every field this module computed and re-derives its own from the
   * current `pages` row. `rows` is already chunked to stay under Postgres's bind-parameter ceiling,
   * so an implementation must not assume one call per page or per run.
   */
  insertVersions(rows: PageHistoryInsertRow[]): Promise<void>
}

export interface PageHistoryImportFailure {
  oldId: number
  message: string
}

export interface PageHistoryImportResult {
  /** Counts rows from an earlier chunk of a page whose backfill later failed partway through. */
  inserted: number
  warnings: string[]
  /** Failure isolates to its own page: one page's history failing does not abort the run. */
  failed: PageHistoryImportFailure[]
}

/**
 * Postgres refuses more than 65535 bind parameters in one statement and `PageHistoryInsertRow` has
 * 12 fields, capping a call at 5461 rows. Chunking applies *within* a single page's history too,
 * not only across pages — one heavily-edited 2.x page can exceed the ceiling alone.
 */
const HISTORY_INSERT_CHUNK_SIZE = 5000

const ACTION_MAP: Record<string, PageHistoryAction> = {
  created: 'created',
  updated: 'updated',
  moved: 'moved',
  deleted: 'deleted',
  restored: 'updated'
}

/**
 * The 2.x column is free text with no db-level constraint, so an unrecognized value warns and
 * defaults rather than throwing — it should not abort an entire page's history.
 */
export function mapHistoryAction(
  action: string | null | undefined,
  context: string,
  warnings: string[]
): PageHistoryAction {
  const key = (action ?? 'updated').trim().toLowerCase()
  const mapped = ACTION_MAP[key]
  if (mapped) {
    return mapped
  }
  warnings.push(
    `${context}: pageHistory action "${action}" is not one of 2.x's confirmed values ` +
      '(updated/moved/deleted/restored) — defaulting to "updated".'
  )
  return 'updated'
}

interface ComparableVersionState {
  title: string
  path: string
  locale: string
  content: string
  description: string
  tags: string[]
  editor: string
  contentType: string
  publishState: string
  publishStartDate: string | null
  publishEndDate: string | null
  extra: Record<string, unknown>
}

function parseVersionDate(entry: StagedPageHistoryEntry): Date {
  const millis = Date.parse(entry.versionDate)
  if (!Number.isNaN(millis)) {
    return new Date(millis)
  }
  // -> Malformed source data degrades to createdAt rather than failing the whole page's backfill.
  const createdMillis = Date.parse(entry.createdAt)
  return new Date(Number.isNaN(createdMillis) ? Date.now() : createdMillis)
}

function buildComparableState(
  page: Pick<StagedPage, 'oldId'>,
  entry: StagedPageHistoryEntry,
  versionDate: Date,
  warnings: string[]
): ComparableVersionState {
  const editor = mapEditor(
    { oldId: page.oldId, editorKey: entry.editorKey, contentType: entry.contentType },
    warnings
  )
  const publishState = derivePublishState(entry, versionDate.getTime())
  return {
    title: entry.title,
    path: entry.path,
    locale: entry.locale,
    content: entry.content ?? '',
    description: entry.description ?? '',
    tags: entry.tags,
    editor,
    contentType: entry.contentType,
    publishState,
    publishStartDate: entry.publishStartDate,
    publishEndDate: entry.publishEndDate,
    extra: entry.extra
  }
}

/**
 * The same field set `record()` builds, per `models/pageHistory.ts`'s `EXCLUDED_FROM_META`. The 2.x
 * schema has no `alias`/`icon`/`config`/`relations`/`isBrowsable`/`isSearchable` at all, so each
 * takes the `db/schema.ts` default `createPage()` would have used.
 *
 * `state.extra` is spread FIRST so a stray same-named key in an old 2.x `extra` blob cannot clobber
 * a computed value; only extra keys with no computed counterpart survive.
 */
function buildMeta(state: ComparableVersionState): Record<string, unknown> {
  return {
    ...state.extra,
    alias: null,
    description: state.description,
    icon: null,
    publishState: state.publishState,
    publishStartDate: state.publishStartDate,
    publishEndDate: state.publishEndDate,
    config: {},
    relations: [],
    tags: state.tags,
    editor: state.editor,
    contentType: state.contentType,
    isBrowsable: true,
    isSearchable: true,
    password: null
  }
}

/** `extra` rides on the state only so `buildMeta` can merge it; it was never a tracked 3.0 `pages`
 * column to diff. */
const NOT_DIFFED: ReadonlySet<keyof ComparableVersionState> = new Set(['extra'])

/**
 * Mirrors `models/pageHistory.ts`'s `changedFields()`, restricted to what `ComparableVersionState`
 * tracks — every key it excludes as bookkeeping is already absent from that state.
 */
function diffComparableStates(
  previous: ComparableVersionState,
  current: ComparableVersionState
): string[] {
  const changed: string[] = []
  for (const key of Object.keys(current) as (keyof ComparableVersionState)[]) {
    if (NOT_DIFFED.has(key)) continue
    if (!isEqual(previous[key], current[key])) {
      changed.push(key)
    }
  }
  return changed.sort()
}

/**
 * Relies on `StagedPage.history` already being sorted ascending by `versionDate`. The oldest entry
 * gets an empty `changedFields`: there is no earlier backfilled version to diff it against, so the
 * whole page is the change.
 *
 * `entry.authorId` is already a resolved 3.0 UUID — `content-staging.ts` ran it through
 * `resolveActorId()`, orphaned-author fallback included — so nothing re-resolves it here.
 *
 * `page` is narrowed to `oldId` (warning context only) and `history` so an orphaned-history group,
 * which has no real `StagedPage`, can reuse this.
 */
export function buildPageHistoryRowsForPage(
  page: Pick<StagedPage, 'oldId' | 'history'>,
  newPageId: string,
  siteId: string,
  warnings: string[]
): PageHistoryInsertRow[] {
  const rows: PageHistoryInsertRow[] = []
  let previousState: ComparableVersionState | null = null

  for (const entry of page.history) {
    const versionDate = parseVersionDate(entry)
    const state = buildComparableState(page, entry, versionDate, warnings)
    const action = mapHistoryAction(
      entry.action,
      `page ${page.oldId} pageHistory ${entry.oldId}`,
      warnings
    )
    const changedFields = previousState ? diffComparableStates(previousState, state) : []

    rows.push({
      pageId: newPageId,
      siteId,
      action,
      changedFields,
      locale: entry.locale,
      path: entry.path,
      title: entry.title,
      content: entry.content,
      meta: buildMeta(state),
      reason: null,
      versionDate,
      authorId: entry.authorId
    })

    previousState = state
  }

  return rows
}

/** Preserves relative order, which is what keeps each group sorted ascending by `versionDate` as
 * `buildPageHistoryRowsForPage` requires. */
function groupOrphanedHistoryBySourcePage(
  orphanedHistory: OrphanedPageHistoryEntry[]
): Map<number, OrphanedPageHistoryEntry[]> {
  const groups = new Map<number, OrphanedPageHistoryEntry[]>()
  for (const entry of orphanedHistory) {
    const group = groups.get(entry.sourcePageOldId)
    if (group) {
      group.push(entry)
    } else {
      groups.set(entry.sourcePageOldId, [entry])
    }
  }
  return groups
}

/**
 * Called per page immediately after its `createPage()`, so a large corpus's history lands page by
 * page rather than buffering to the end of a run.
 *
 * Never throws: an `insertVersions()` rejection is reported as this page's own failure, so one
 * page's history failing cannot abort a run already past the point of creating pages.
 */
export async function backfillPageHistoryForPage(
  page: Pick<StagedPage, 'oldId' | 'history'>,
  newPageId: string,
  siteId: string,
  deps: PageHistoryImportDeps
): Promise<PageHistoryImportResult> {
  const warnings: string[] = []
  const failed: PageHistoryImportFailure[] = []
  let inserted = 0

  if (page.history.length === 0) {
    return { inserted, warnings, failed }
  }

  const rows = buildPageHistoryRowsForPage(page, newPageId, siteId, warnings)
  try {
    for (let offset = 0; offset < rows.length; offset += HISTORY_INSERT_CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + HISTORY_INSERT_CHUNK_SIZE)
      await deps.insertVersions(chunk)
      inserted += chunk.length
    }
  } catch (err: any) {
    failed.push({ oldId: page.oldId, message: `pageHistory insert failed: ${err.message}` })
  }

  return { inserted, warnings, failed }
}

export async function backfillOrphanedPageHistory(
  orphanedHistory: OrphanedPageHistoryEntry[],
  siteId: string,
  deps: PageHistoryImportDeps
): Promise<PageHistoryImportResult> {
  const warnings: string[] = []
  const failed: PageHistoryImportFailure[] = []
  let inserted = 0

  for (const [sourcePageOldId, entries] of groupOrphanedHistoryBySourcePage(orphanedHistory)) {
    const synthesizedPageId = crypto.randomUUID()
    const result = await backfillPageHistoryForPage(
      { oldId: sourcePageOldId, history: entries },
      synthesizedPageId,
      siteId,
      deps
    )
    inserted += result.inserted
    warnings.push(...result.warnings)
    failed.push(...result.failed)
  }

  return { inserted, warnings, failed }
}
