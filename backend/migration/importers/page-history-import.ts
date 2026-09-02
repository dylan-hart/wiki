import { isEqual } from 'es-toolkit/predicate'
import type { PageHistoryAction } from '../../models/pageHistory.ts'
import type {
  OrphanedPageHistoryEntry,
  StagedPage,
  StagedPageHistoryEntry
} from '../content-staging.ts'
import { derivePublishState, mapEditor } from './page-import.ts'

/**
 * Page history backfill via a direct `pageHistory` insert
 *
 * `WIKI.models.pageHistory.record()` (`backend/models/pageHistory.ts:143`) only ever snapshots the
 * CURRENT `pages` row — it reads the row fresh from `pagesTable` and writes exactly that. Its only
 * concession to a caller who isn't editing *right now* is `versionDate` (added alongside this task, to
 * carry `PageInput.updatedAt` through so that row is dated the source's real last-modified time rather
 * than import time — see upstream requarks/wiki#4631), but it still has no way to express any of the
 * *past* versions a 2.x page's history chain carries — only ever the current one. `./page-import.ts`'s
 * `page-import.ts` already calls `createPage()` once per page, which itself calls `record()` once,
 * giving every imported page a single `pageHistory` row for its state *as of its own `updatedAt`*.
 * This module is what turns each of that page's remaining 2.x
 * `pageHistory` rows (`StagedPage.history`, `../content-staging.ts`) into an equivalent 3.0
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
 *
 * ## Chunked inserts
 *
 * `PageHistoryInsertRow` has 12 fields, and a single `WIKI.db.insert(pageHistoryTable).values(rows)`
 * call binds every field of every row as its own parameter — Postgres refuses more than 65535 bind
 * parameters per statement, a ceiling a mature 2.x install's most-edited page can cross alone at
 * around 5461 revisions. `backfillPageHistoryForPage()` (called once per page, immediately after that
 * page's `createPage()` — see `./page-import.ts`) chunks a single page's rows at
 * `HISTORY_INSERT_CHUNK_SIZE`, and never buffers more than one page's history in memory or in one
 * `insertVersions()` call — see `../content-staging.ts`'s own streaming design for the matching page-side
 * half of this fix. An orphaned-history group (below) goes through the exact same
 * `backfillPageHistoryForPage()` and therefore the exact same chunking.
 *
 * ## Orphaned history (a `pageId` naming no current 2.x page)
 *
 * `content-staging.ts`'s `extractContentStaging()` splits `pageHistory` rows into each page's own
 * `StagedPage.history` and a separate `orphanedHistory: OrphanedPageHistoryEntry[]` list, for rows
 * whose `pageId` matched no page among the source's current `pages` (almost always a 2.x page that
 * was deleted and never recreated). `pageHistory.pageId` is a non-FK plain column on both 2.x and
 * 3.0 *by design* (`db/schema.ts`'s comment on the column, `docs/migration/2.5x-to-3.0-mapping.md`)
 * specifically so history outlives the page it belonged to — every `WIKI.models.pageHistory` reader
 * (`list`, `getVersion`, `listRecoverable`, `getDeletedVersion`, `recoverDeletedPage`) keys off
 * `siteId`+`pageId` or `siteId`+`locale`+`path`, never a join back to `pages`, so a `pageId` that
 * names no live page is exactly the shape `listRecoverable`'s "recoverable" query already expects
 * for any deleted page. `backfillOrphanedPageHistory` inserts those rows, grouped by
 * `sourcePageOldId` and given one freshly synthesized UUID per group (not one per row, so a deleted
 * page's whole chain — including the `deleted` row itself — shares a single `pageId`, the same way
 * a live page's history rows all share its real new `pages.id`). See
 * `docs/migration/2.5x-to-3.0-mapping.md`'s `pageId` row for the full reasoning.
 *
 * ## `extra` merges into `meta`, underneath the computed keys
 *
 * 2.x's `pageHistory.extra` catch-all JSON blob (`content-staging.ts`'s `StagedPageHistoryEntry.extra`)
 * is spread into `buildMeta`'s result, but *underneath* the 14 keys `buildMeta` itself computes —
 * `Object.assign({}, entry.extra, computed)` order, not the reverse — so a same-named stray key
 * inside an old `extra` blob (e.g. a leftover `extra.tags`) can never clobber the real derived
 * value. See `docs/migration/2.5x-to-3.0-mapping.md`'s `extra` row.
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
   * Inserts already-built rows directly into the `pageHistory` table, for at most one page's worth
   * of rows at a time (see `HISTORY_INSERT_CHUNK_SIZE` below — a single call is not guaranteed to be
   * one page's *entire* history, only ever a chunk of it).
   *
   * DELIBERATE EXCEPTION to "always go through the model" (see the module doc comment above for
   * why `record()` cannot do this instead): the real implementation — wired up by
   * `phases/content.ts`, same as every other injected dependency here — does exactly one thing per
   * call, `WIKI.db.insert(pageHistoryTable).values(rows)`, and nothing more.
   * It must NOT call `WIKI.models.pageHistory.record()`, because `record()` ignores every field this
   * module computed and re-derives its own from the current `pages` row instead — the opposite of
   * what a historical backfill needs.
   *
   * It also must not assume it will be called exactly once per run, or once per page: `rows` is
   * chunked (per page, and further within a page above `HISTORY_INSERT_CHUNK_SIZE` rows) precisely
   * so this can be a plain, unconditional `insert().values(rows)` without ever handing Postgres more
   * bind parameters than its 65535 ceiling allows — see the module doc comment's "Chunked inserts"
   * section.
   */
  insertVersions(rows: PageHistoryInsertRow[]): Promise<void>
}

/** One page whose history failed to backfill — the `pageId`/`content` values it *would* have carried
 * either never left the process or landed in an earlier, already-committed chunk; either way, the
 * page itself (already created by `page-import.ts`) is unaffected, only its history is incomplete. */
export interface PageHistoryImportFailure {
  oldId: number
  message: string
}

export interface PageHistoryImportResult {
  /** How many `pageHistory` rows were actually inserted, across every page and chunk — includes rows
   * from any earlier chunk of a page whose backfill later failed partway through. */
  inserted: number
  warnings: string[]
  /** One entry per page whose `insertVersions()` call(s) threw, so one page's history failing does
   * not lose the run's ability to report on every other page's. */
  failed: PageHistoryImportFailure[]
}

/**
 * Rows per `insertVersions()` call. `PageHistoryInsertRow` has 12 fields, and Postgres refuses more
 * than 65535 bind parameters in one statement — `floor(65535 / 12) = 5461` — so this stays safely
 * under that ceiling with room to spare, chunking within a single page's history whenever it alone
 * exceeds this (the largest 2.x installs' most-edited pages can), not only across pages.
 */
const HISTORY_INSERT_CHUNK_SIZE = 5000

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
  /** The 2.x row's own `extra` catch-all blob, carried through so `buildMeta` can merge it — not
   * itself part of the changed-fields diff (see `diffComparableStates`'s exclusion below), since
   * `extra` was never a tracked 3.0 `pages` field to begin with. */
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
 * Builds `meta` exactly the way `record()` does: every field 3.0's `pages` row carries beyond the
 * ones held in `pageHistory`'s own `locale`/`path`/`title`/`content` columns
 * (`EXCLUDED_FROM_META` in `backend/models/pageHistory.ts`). 2.x's history rows carry no
 * `alias`/`icon`/`config`/`relations`/`isBrowsable`/`isSearchable` of their own — none of
 * those exist in the 2.x schema at all — so each is set to the same default `createPage()` itself
 * would have used for a page that never specified one, per `db/schema.ts`'s column defaults.
 *
 * `state.extra` — 2.x's own `pageHistory.extra` catch-all blob — is spread in FIRST, so every key
 * below it overrides a same-named key `extra` might carry (a stray old `extra.tags`, most plausibly).
 * Only genuine extra keys with no computed counterpart survive into the result untouched.
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

/** Every `ComparableVersionState` key that is not itself a `changedFields()`-comparable page field —
 * `extra` is carried on the state purely so `buildMeta` can merge it (see above), it was never a
 * tracked 3.0 `pages` column to diff. */
const NOT_DIFFED: ReadonlySet<keyof ComparableVersionState> = new Set(['extra'])

/**
 * Diffs two consecutive versions over the same field set `changedFields()` in
 * `backend/models/pageHistory.ts` compares, restricted to what `ComparableVersionState` actually
 * tracks. `NOT_REPORTED_AS_CHANGED` excludes bookkeeping (`render`/`toc`/`searchContent`/`ts`/`hash`/
 * `authorId`/`updatedAt`/rating/`historyData`) — none of which is a field this module diffs to begin
 * with, so every key here (besides `NOT_DIFFED`) is compared; nothing needs excluding a second time.
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
 * Builds every `pageHistory` insert row for one page's 2.x history chain, in `versionDate` order
 * (`StagedPage.history` is already sorted ascending by `content-staging.ts`). The oldest entry gets
 * an empty `changedFields` — there is no earlier backfilled version to diff it against, the same
 * reasoning `record()`'s own doc comment gives for a creation or a deletion: "the whole page is the
 * change." Every later entry's `changedFields` is a real diff against the immediately preceding
 * entry, over the same field set `changedFields()` compares (`NOT_REPORTED_AS_CHANGED`'s
 * exclusions — none of which apply to the page-shaped fields tracked here).
 *
 * `authorId` is **not** resolved here: `../content-staging.ts`'s `stageHistoryEntry()`
 * already ran every entry's 2.x `authorId` through `resolveActorId()` with the same orphaned-author
 * operator fallback `StagedPage.authorId`/`creatorId` use, so `entry.authorId` is already the
 * resolved 3.0 UUID this row needs.
 *
 * `page` only needs `oldId` (used solely for warning context via `mapEditor`) and `history` — narrowed
 * to that pair rather than the full `StagedPage` so `backfillOrphanedPageHistory` can reuse this for
 * an orphaned-history group too, which has no real `StagedPage` to hand in (see the module doc comment's
 * "Orphaned history" section).
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

/** Groups `orphanedHistory` by `sourcePageOldId`, preserving each group's relative order — the list
 * arrives already sorted by `versionDate` ascending (`content-staging.ts`'s `extractContentStaging`),
 * so filtering into groups keeps every group internally sorted too, exactly what
 * `buildPageHistoryRowsForPage` expects. */
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
 * Backfills `pageHistory` for one already-created page — the per-page entry point `page-import.ts`
 * (`./page-import.ts`) calls immediately after its own `createPage()` call for that page,
 * so a large corpus's history lands page by page rather than all at once at the end of a run. Builds
 * the page's whole 2.x history chain as direct `pageHistory` inserts (see the module doc comment for
 * why `record()` cannot do this), chunked at `HISTORY_INSERT_CHUNK_SIZE` rows per `insertVersions()`
 * call so one page's history can never alone exceed Postgres's bind-parameter ceiling.
 *
 * Never throws: an `insertVersions()` rejection is caught and reported as this page's own
 * `PageHistoryImportFailure` rather than propagated, so one page's history failing cannot abort a
 * run already past the point of having created that page (or any other).
 *
 * `page` only needs `oldId` and `history` (see `buildPageHistoryRowsForPage`'s own narrowing for why)
 * — `backfillOrphanedPageHistory` below reuses this same function for an orphaned-history group, which
 * has no real `StagedPage` to hand in, only a synthesized `pageId` and the group's own entries.
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

/**
 * Backfills the `pageHistory` rows that have no live page to hang off — `pageHistory` rows whose
 * `pageId` named no current 2.x page, staged separately by `content-staging.ts` — per the module doc
 * comment's "Orphaned history" section: grouped by `sourcePageOldId`, each group gets one freshly
 * synthesized `pageId` (`crypto.randomUUID()`) shared by every row in that group, and goes through
 * the exact same `backfillPageHistoryForPage` a real page's history goes through — chunking and
 * per-group failure isolation included.
 *
 * Every *live* page's own history is backfilled per-page, inline, as `page-import.ts` streams
 * (`ImportPagesDeps.backfillHistory` → `backfillPageHistoryForPage`), so there is nothing left for
 * this function to do about them.
 */
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
