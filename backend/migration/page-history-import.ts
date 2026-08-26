import { isEqual } from 'es-toolkit/predicate'
import type { PageHistoryAction } from '../models/pageHistory.ts'
import type { StagedPage, StagedPageHistoryEntry } from './content-staging.ts'
import { derivePublishState, mapEditor } from './page-import.ts'
import type { IdMap } from './id-map.ts'

/**
 * Page history backfill via a direct `pageHistory` insert (Feature 416 / Task 740)
 *
 * `WIKI.models.pageHistory.record()` (`backend/models/pageHistory.ts:143`) only ever snapshots the
 * CURRENT `pages` row — it reads the row fresh from `pagesTable` and writes exactly that. Its only
 * concession to a caller who isn't editing *right now* is `versionDate` (added alongside this task, to
 * carry `PageInput.updatedAt` through so that row is dated the source's real last-modified time rather
 * than import time — see upstream requarks/wiki#4631), but it still has no way to express any of the
 * *past* versions a 2.x page's history chain carries — only ever the current one. Task 738's
 * `importPages()` already calls `createPage()` once per page, which itself calls `record()` once,
 * giving every imported page a single `pageHistory` row for its state *as of its own `updatedAt`*.
 * This module is what turns each of that page's remaining 2.x
 * `pageHistory` rows (`StagedPage.history`, Task 733's `content-staging.ts`) into an equivalent 3.0
 * row — reproducing everything `record()` would have computed (`meta`'s field set, `changedFields`'s
 * diff, the action) by hand, because there is no model method that can be called for a version that
 * isn't the current one.
 *
 * ## 2.x's `action` vocabulary is not 3.0's four
 *
 * `docs/migration/2.5x-to-3.0-mapping.md` flags `pageHistory.action` as needing a vocabulary mapping
 * without saying what 2.x actually writes. Checked against the 2.x source directly
 * (`server/models/pages.js`, `server/models/pageHistory.js`, `server/graph/resolvers/page.js`):
 *
 *   - `updatePage()` writes `'updated'` (or whatever `opts.action` names — see the `restore` row
 *     below), `convertPage()` writes `'updated'`, `movePage()` writes `'moved'`, `deletePage()`
 *     writes `'deleted'`. The column itself defaults to `'updated'` when omitted (nullable in the
 *     2.x schema).
 *   - The GraphQL `restore` resolver calls `updatePage()` with `action: 'restored'` — so `'restored'`
 *     is a real, reachable value, not a documentation gap.
 *   - **2.x never writes `'created'`.** `createPage()` inserts the `pages` row directly and never
 *     calls `pageHistory.addVersion()` — the *first* history row a page ever gets is written by
 *     whatever edit/move/delete/restore happens *after* creation, and (because `addVersion()` is
 *     always called with the pre-mutation snapshot) that row's own `meta`/`content` faithfully
 *     *is* the page as it was originally created; only its `action` names the edit that followed,
 *     not "created". 3.0 has no such gap (`createPage()` always writes its own `action: 'created'`
 *     row), so nothing here needs to synthesize one — mapping the oldest 2.x row's own action
 *     through {@link mapHistoryAction} (typically `'updated'`) is the correct, literal reproduction of
 *     what that row recorded.
 *
 * 3.0 also has no `'restored'` action at all — `PageHistoryOverlay.vue`'s restore flow is an
 * ordinary content `PATCH`, indistinguishable from any other edit, so `record()` never writes
 * anything but `'created'`/`'updated'`/`'moved'`/`'deleted'`. `mapHistoryAction` folds 2.x's
 * `'restored'` onto 3.0's `'updated'` accordingly, and falls back to `'updated'` (with a warning) for
 * any other free-text value the column allows but no known writer ever produced.
 */

/** One `pageHistory` row this module has finished building, ready to be inserted verbatim — column
 * names and types match `db/schema.ts`'s `pageHistory` table. */
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
   * Inserts already-built rows directly into the `pageHistory` table.
   *
   * DELIBERATE EXCEPTION to "always go through the model" (see the module doc comment above for
   * why `record()` cannot do this instead): the real implementation — wired up by Task 421's CLI,
   * same as every other injected dependency across this migration feature — is expected to do
   * exactly one thing, `WIKI.db.insert(pageHistoryTable).values(rows)`, and nothing more. It must
   * NOT call `WIKI.models.pageHistory.record()`, because `record()` ignores every field this module
   * computed and re-derives its own from the current `pages` row instead — the opposite of what a
   * historical backfill needs.
   */
  insertVersions(rows: PageHistoryInsertRow[]): Promise<void>
}

export interface PageHistoryImportResult {
  /** How many `pageHistory` rows were inserted, across every page. */
  inserted: number
  warnings: string[]
}

/** 2.x's confirmed `pageHistory.action` vocabulary (see the module doc comment) mapped onto 3.0's
 * four. `'restored'` collapses onto `'updated'` because 3.0 has no equivalent of its own. */
const ACTION_MAP: Record<string, PageHistoryAction> = {
  created: 'created',
  updated: 'updated',
  moved: 'moved',
  deleted: 'deleted',
  restored: 'updated'
}

/**
 * Maps a 2.x `pageHistory.action` value onto one of 3.0's four. Anything outside the confirmed
 * vocabulary (the column is free text with no db-level constraint) falls back to `'updated'` with a
 * warning rather than throwing — one unrecognized value should not abort an entire page's history.
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

/** The page-shaped fields `meta` and `changedFields` both need per version — built once per entry so
 * consecutive versions can be diffed by comparing two of these rather than two raw staged rows. */
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
    publishEndDate: entry.publishEndDate
  }
}

/**
 * Builds `meta` exactly the way `record()` does: every field 3.0's `pages` row carries beyond the
 * ones held in `pageHistory`'s own `locale`/`path`/`title`/`content` columns
 * (`EXCLUDED_FROM_META` in `backend/models/pageHistory.ts`). 2.x's history rows carry no
 * `alias`/`icon`/`config`/`relations`/`isBrowsable`/`isSearchable` of their own — none of
 * those exist in the 2.x schema at all — so each is set to the same default `createPage()` itself
 * would have used for a page that never specified one, per `db/schema.ts`'s column defaults.
 */
function buildMeta(state: ComparableVersionState): Record<string, unknown> {
  return {
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

/**
 * Diffs two consecutive versions over the same field set `changedFields()` in
 * `backend/models/pageHistory.ts` compares, restricted to what `ComparableVersionState` actually
 * tracks. `NOT_REPORTED_AS_CHANGED` excludes bookkeeping (`render`/`toc`/`searchContent`/`ts`/`hash`/
 * `authorId`/`updatedAt`/rating/`historyData`/`isSearchableComputed`) — none of which is a field this
 * module diffs to begin with, so every key here is compared; nothing needs excluding a second time.
 */
function diffComparableStates(
  previous: ComparableVersionState,
  current: ComparableVersionState
): string[] {
  const changed: string[] = []
  for (const key of Object.keys(current) as (keyof ComparableVersionState)[]) {
    if (!isEqual(previous[key], current[key])) {
      changed.push(key)
    }
  }
  return changed.sort()
}

/**
 * Builds every `pageHistory` insert row for one page's 2.x history chain, in `versionDate` order
 * (`StagedPage.history` is already sorted ascending by `content-staging.ts`). The oldest entry gets
 * an empty `changedFields` — there is no earlier backfilled version to diff it against, the same
 * reasoning `record()`'s own doc comment gives for a creation or a deletion: "the whole page is the
 * change." Every later entry's `changedFields` is a real diff against the immediately preceding
 * entry, over the same field set `changedFields()` compares (`NOT_REPORTED_AS_CHANGED`'s
 * exclusions — none of which apply to the page-shaped fields tracked here).
 *
 * `authorId` is **not** resolved here: `content-staging.ts`'s `stageHistoryEntry()` (Task 733)
 * already ran every entry's 2.x `authorId` through `resolveActorId()` with the same orphaned-author
 * operator fallback `StagedPage.authorId`/`creatorId` use, so `entry.authorId` is already the
 * resolved 3.0 UUID this row needs.
 */
export function buildPageHistoryRowsForPage(
  page: StagedPage,
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

/**
 * Backfills `pageHistory` for every successfully-imported page in `pages`, per this task's
 * description: immediately after `importPages()`'s own `createPage()` call for a page (resolved here
 * through `pageIdMap`, the same map `importPages()` populated), insert its whole 2.x history chain as
 * a direct `pageHistory` insert (see the module doc comment for why `record()` cannot do this).
 *
 * A page absent from `pageIdMap` (one of `PageImportResult.failed`, per `page-import.ts`) is skipped
 * silently — there is no 3.0 page for its history to attach to, and `importPages()` already reported
 * why it failed.
 */
export async function backfillPageHistory(
  pages: StagedPage[],
  pageIdMap: IdMap<number>,
  siteId: string,
  deps: PageHistoryImportDeps
): Promise<PageHistoryImportResult> {
  const warnings: string[] = []
  const rows: PageHistoryInsertRow[] = []

  for (const page of pages) {
    if (page.history.length === 0) continue
    const newPageId = pageIdMap.get(page.oldId)
    if (!newPageId) continue
    rows.push(...buildPageHistoryRowsForPage(page, newPageId, siteId, warnings))
  }

  if (rows.length > 0) {
    await deps.insertVersions(rows)
  }

  return { inserted: rows.length, warnings }
}
