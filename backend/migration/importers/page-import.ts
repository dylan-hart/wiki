import { normalizeMigratedPath } from '../path-normalization.ts'
import type { PathAssignmentOptions, TreePathAssignment } from '../path-normalization.ts'
import type { StagedPage } from '../content-staging.ts'
import type { PageHistoryImportResult } from './page-history-import.ts'
import type { Page, PageActor, PageInput } from '../../models/pages.ts'
import { MAX_NAME_ATTEMPTS } from '../../models/tree.ts'

/**
 * Every page goes through `CARDINAL.models.pages.createPage()`, never a raw insert: that method also
 * writes the matching `tree` row, records the first `pageHistory` row and indexes the page for
 * search, all of which a hand-rolled insert here would drift from.
 *
 * ## Single-pass streaming
 *
 * Pages arrive one at a time through `importOne()`, so `extractContentStaging()`'s generator never
 * buffers the corpus — at most one page's heavy fields (`content`/`render`/`toc`/history `content`)
 * are resident. Each page is created and its history backfilled before the caller pulls the next.
 *
 * That shape constrains collision semantics: by the time a later page is found to collide with an
 * earlier one, the earlier page already exists, so "fail both sides" is unavailable. See
 * `resolveStreamedFileName()` for what happens instead.
 *
 * ## The synthetic per-page actor
 *
 * `PageInput` has no authorship field — `createPage()` hardcodes `authorId`/`creatorId`/`ownerId` to
 * the calling actor. To still carry the identity `content-staging.ts` resolved, `importOne()` builds
 * one synthetic `PageActor` per page from `staged.creatorId`. That actor holds no group membership,
 * so it could never earn `write:scripts`/`write:styles` through the ordinary page-rule engine, which
 * resolves those from `groupIds`-derived rules only and never from a flat `permissions` list;
 * `forcedPagePermissions` is `hasPermission()`'s escape hatch for exactly this caller. A migration is
 * not "logged in as" each original 2.x author, so deriving authority from that (possibly
 * unprivileged, possibly nonexistent) author would make the result depend on who happened to write
 * the page rather than on a deliberate operator decision.
 *
 * `StagedPage.authorId` — 2.x's *last editor* — has nowhere to land, since the call collapses both
 * onto `creatorId`. The real per-revision `authorId` is restored by `./page-history-import.ts`, which
 * inserts `pageHistory` rows directly and so is not bound by the single-actor model.
 *
 * ## The render bootstrap decision
 *
 *   - **`'passthrough'` (the default)**: 2.x's stored `render` HTML becomes `input.render`, which
 *     `createPage()` sanitizes and extracts `toc`/`searchContent` from at once, so the page is
 *     readable and searchable the instant it exists — at the cost of HTML reflecting 2.x's renderer
 *     and plugin set until the page is next edited or explicitly re-rendered.
 *   - **`'queue'`**: leaving `input.render` undefined makes `createPage()` queue the headless-browser
 *     `renderPages` job instead, producing a native 3.0 render. That is one browser render per page
 *     across the whole imported wiki — a real cost in time and Puppeteer pressure an operator may
 *     prefer to incur gradually, hence opt-in.
 */

export interface PagesWriteModel {
  createPage(siteId: string, input: PageInput, actor: PageActor): Promise<Page>
}

export interface ImportPagesDeps {
  pagesModel: PagesWriteModel
  existingEntry: PathAssignmentOptions['existingEntry']
  /**
   * Omitting it skips history backfill entirely — the importer never reaches for one of its own. A
   * `PageHistoryImportResult.failed` folds into that page's own `warnings` rather than failing the
   * page, which already succeeded by the time this runs.
   */
  backfillHistory?: (page: StagedPage, newPageId: string) => Promise<PageHistoryImportResult>
}

export interface ImportPagesOptions {
  siteId: string
  /** Force-granted to every synthetic per-page actor, bypassing the group-rule engine — see "The
   * synthetic per-page actor" above for why the importer's actor cannot use a real page rule. */
  forcedPagePermissions: string[]
  renderBootstrap?: 'passthrough' | 'queue'
  /** Epoch milliseconds treated as "now" when deriving `publishState`; injectable so a test is
   * deterministic. */
  now?: number
}

/**
 * - `'sibling-collision'`: clashed with an earlier page in this same streaming run, and every
 *   numeric-suffix retry clashed too — it never fires on the first collision alone.
 * - `'existing-entry-collision'`: the location already holds a pre-existing 3.0 tree entry. Fires
 *   immediately with no retry, which is what lets `phases/content.ts` read it as "already migrated".
 */
export type PageImportFailureReason =
  | 'empty-path'
  | 'invalid-segment'
  | 'sibling-collision'
  | 'existing-entry-collision'
  | 'create-error'

export interface PageImportSuccess {
  oldId: number
  pageId: string
  warnings: string[]
  action: 'created'
}

/** Keyed by 2.x's own `editorKey`, whose recognized values match `pages.ts`'s `EDITOR_CONTENT_TYPES`
 * except for `ckeditor`, 2.x's name for the WYSIWYG editor. */
const EDITOR_KEY_MAP: Record<string, string> = {
  markdown: 'markdown',
  asciidoc: 'asciidoc',
  wysiwyg: 'wysiwyg',
  ckeditor: 'wysiwyg',
  redirect: 'redirect'
}

const CONTENT_TYPE_EDITOR_HINT: Record<string, string> = {
  markdown: 'markdown',
  asciidoc: 'asciidoc',
  html: 'wysiwyg',
  redirect: 'redirect'
}

const DEFAULT_FALLBACK_EDITOR = 'markdown'

/**
 * Warns whenever `editorKey` was present but unrecognized, even when `contentType` recovered a
 * sensible editor anyway — the editor a page opens in is approximate from that point on, and only a
 * warning says so.
 */
export function mapEditor(
  staged: Pick<StagedPage, 'oldId' | 'editorKey' | 'contentType'>,
  warnings: string[]
): string {
  const key = staged.editorKey
  if (key && EDITOR_KEY_MAP[key]) {
    return EDITOR_KEY_MAP[key]
  }
  const hinted = CONTENT_TYPE_EDITOR_HINT[staged.contentType]
  if (key) {
    warnings.push(
      hinted
        ? `page ${staged.oldId}: editorKey "${key}" has no 3.0 equivalent — inferred editor "${hinted}" from contentType "${staged.contentType}" instead.`
        : `page ${staged.oldId}: editorKey "${key}" has no 3.0 equivalent and contentType "${staged.contentType}" gave no usable hint — defaulting to editor "${DEFAULT_FALLBACK_EDITOR}". Content is preserved as-is; only the editing UI this page opens in afterwards is approximate.`
    )
  }
  return hinted ?? DEFAULT_FALLBACK_EDITOR
}

function parseMillis(value: string | null): number | null {
  if (!value) return null
  const millis = Date.parse(value)
  return Number.isNaN(millis) ? null : millis
}

/**
 * `Date.parse` rather than `new Date(...)`: the latter never throws for garbage input, it just
 * becomes an `Invalid Date` that `createPage()` would try to insert. Malformed source data degrades
 * to `undefined` — the column's `now()` default — rather than failing the whole page.
 */
function normalizeStagedDate(value: string): string | undefined {
  return Number.isNaN(Date.parse(value)) ? undefined : value
}

/**
 * `null` is a normal source value (no date set), so only a non-empty value that fails to parse is a
 * data problem worth warning about.
 */
function normalizeStagedPublishDate(
  value: string | null,
  field: 'publishStartDate' | 'publishEndDate',
  oldId: number,
  warnings: string[]
): string | null {
  if (value === null) return null
  const normalized = normalizeStagedDate(value)
  if (normalized === undefined) {
    warnings.push(`page ${oldId}: ${field} "${value}" could not be parsed as a date — dropped.`)
    return null
  }
  return normalized
}

/**
 * A window that has already ended lands on `'scheduled'` alongside one that has not started: 3.0 has
 * no distinct "expired" state, and `updatePage`'s guard only requires *some* date to be present for
 * `'scheduled'`, not specifically a future start. A date that fails to parse is treated as absent
 * rather than thrown on, so bad source data degrades the derivation instead of aborting the page.
 */
export function derivePublishState(
  staged: Pick<StagedPage, 'isPublished' | 'publishStartDate' | 'publishEndDate'>,
  nowMillis: number
): 'draft' | 'published' | 'scheduled' {
  if (!staged.isPublished) return 'draft'
  const start = parseMillis(staged.publishStartDate)
  const end = parseMillis(staged.publishEndDate)
  if (start === null && end === null) return 'published'
  const beforeStart = start !== null && nowMillis < start
  const afterEnd = end !== null && nowMillis > end
  return beforeStart || afterEnd ? 'scheduled' : 'published'
}

export function describePrivacyWarning(
  staged: Pick<StagedPage, 'oldId' | 'isPrivate' | 'privateNS'>
): string | null {
  if (!staged.isPrivate && !staged.privateNS) return null
  const ns = staged.privateNS ? ` (privateNS "${staged.privateNS}")` : ''
  return (
    `page ${staged.oldId}: 2.x isPrivate=${staged.isPrivate}${ns} has no 3.0 destination — page-level ` +
    'privacy in 3.0 is expressed through page-rule permissions (a read:pages DENY/ALLOW/FORCEALLOW ' +
    'rule), not a column, and nothing derives one from a 2.x page. The page was imported publicly ' +
    'readable; add an equivalent page rule by hand.'
  )
}

interface MappedPage {
  input: PageInput
  actor: PageActor
  warnings: string[]
}

function mapStagedPageToInput(
  staged: StagedPage,
  assignment: TreePathAssignment,
  renderBootstrap: 'passthrough' | 'queue',
  nowMillis: number,
  forcedPagePermissions: string[]
): MappedPage {
  const warnings: string[] = []
  const editor = mapEditor(staged, warnings)
  const publishState = derivePublishState(staged, nowMillis)

  const privacyWarning = describePrivacyWarning(staged)
  if (privacyWarning) warnings.push(privacyWarning)

  if (staged.authorId !== staged.creatorId) {
    warnings.push(
      `page ${staged.oldId}: 2.x's authorId (last editor) differs from creatorId (original author); ` +
        'createPage() only accepts one identity for authorId/creatorId/ownerId on the initial 3.0 row, ' +
        'so creatorId was used for all three — the real per-revision authorId is restored by the ' +
        'pageHistory backfill.'
    )
  }

  // -> createPage()'s ensureCanRender throws renderUnsupportedEditor for every editor but markdown,
  //    so 'queue' falls back per-page rather than failing a page over a bootstrap preference.
  const canQueue = renderBootstrap === 'queue' && editor === 'markdown'
  if (renderBootstrap === 'queue' && !canQueue) {
    warnings.push(
      `page ${staged.oldId}: renderBootstrap "queue" was requested but native server-side re-rendering ` +
        `only supports the markdown editor (this page resolved to "${editor}") — falling back to ` +
        'passing the imported render through for this page.'
    )
  }

  const input: PageInput = {
    path: assignment.path,
    title: staged.title,
    editor,
    content: staged.content ?? '',
    render: canQueue ? undefined : (staged.render ?? undefined),
    locale: staged.locale,
    description: staged.description ?? '',
    publishState,
    publishStartDate: normalizeStagedPublishDate(
      staged.publishStartDate,
      'publishStartDate',
      staged.oldId,
      warnings
    ),
    publishEndDate: normalizeStagedPublishDate(
      staged.publishEndDate,
      'publishEndDate',
      staged.oldId,
      warnings
    ),
    tags: staged.tags,
    // -> Left unset, createPage()'s now() default stamps every imported page with import time
    //    instead of the source's own dates (upstream requarks/wiki#4631).
    createdAt: normalizeStagedDate(staged.createdAt),
    updatedAt: normalizeStagedDate(staged.updatedAt)
  }

  return {
    input,
    actor: { id: staged.creatorId, groupIds: [], permissions: [], forcedPagePermissions },
    warnings
  }
}

/** A space is a safe separator because each part is either a locale code or already folded to
 * `path-normalization.ts`'s `RE_FOLDER_SEGMENT`, so none of them can contain one. */
function streamedLocationKey(locale: string, parentPath: string, fileName: string): string {
  return `${locale} ${parentPath} ${fileName}`
}

interface StreamedNameConflict {
  reason: 'sibling-collision' | 'existing-entry-collision'
  claimedByOldId?: number
}

async function checkLocationConflict(
  siteId: string,
  locale: string,
  parentPath: string,
  fileName: string,
  claimedLocations: Map<string, number>,
  existingEntry: PathAssignmentOptions['existingEntry']
): Promise<StreamedNameConflict | null> {
  const claimedByOldId = claimedLocations.get(streamedLocationKey(locale, parentPath, fileName))
  if (claimedByOldId !== undefined) {
    return { reason: 'sibling-collision', claimedByOldId }
  }
  if (await existingEntry(siteId, locale, parentPath, fileName)) {
    return { reason: 'existing-entry-collision' }
  }
  return null
}

type StreamedNameResolution =
  | { status: 'free'; fileName: string }
  | { status: 'renamed'; fileName: string; conflict: StreamedNameConflict }
  | { status: 'exhausted'; conflict: StreamedNameConflict }

/**
 * Only a `'sibling-collision'` on the unsuffixed name enters the `name-1`, `name-2`, … retry loop,
 * whose cap is `models/tree.ts`'s `MAX_NAME_ATTEMPTS` — the same dedupe `resolveName`'s
 * `onConflict: 'suffix'` branch applies to assets. An `'existing-entry-collision'` on the unsuffixed
 * name is left `'exhausted'` immediately: `phases/content.ts#toRecordOutcome()` reads that reason as
 * "this page already exists at the destination" and skips it idempotently when the CLI is re-run
 * after an interrupted attempt, where a `name-1` rename would instead duplicate a migrated page. A
 * *suffixed* candidate hitting an existing entry carries no such signal — that name was never this
 * page's canonical target — so it is just unavailable and the loop moves on.
 *
 * `'exhausted'` always reports the FIRST conflict seen, since that is what explains why the page
 * cannot land; a suffixed candidate's own reason only decides whether a free name was found.
 */
async function resolveStreamedFileName(
  siteId: string,
  locale: string,
  parentPath: string,
  fileName: string,
  claimedLocations: Map<string, number>,
  existingEntry: PathAssignmentOptions['existingEntry']
): Promise<StreamedNameResolution> {
  const initialConflict = await checkLocationConflict(
    siteId,
    locale,
    parentPath,
    fileName,
    claimedLocations,
    existingEntry
  )
  if (!initialConflict) {
    return { status: 'free', fileName }
  }
  if (initialConflict.reason === 'existing-entry-collision') {
    return { status: 'exhausted', conflict: initialConflict }
  }

  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = `${fileName}-${attempt}`
    const candidateConflict = await checkLocationConflict(
      siteId,
      locale,
      parentPath,
      candidate,
      claimedLocations,
      existingEntry
    )
    if (!candidateConflict) {
      return { status: 'renamed', fileName: candidate, conflict: initialConflict }
    }
  }

  return { status: 'exhausted', conflict: initialConflict }
}

function describeStreamedNameConflictFailure(
  oldId: number,
  normalizedPath: string,
  locale: string,
  conflict: StreamedNameConflict
): string {
  if (conflict.reason === 'sibling-collision') {
    return (
      `page ${oldId} at "${normalizedPath}" (locale "${locale}") normalizes to the same tree ` +
      `location as page ${conflict.claimedByOldId}, already imported earlier in this streaming run, ` +
      `and every numeric-suffix retry (up to ${MAX_NAME_ATTEMPTS}) also collided — the earlier page ` +
      'was kept, this one was not.'
    )
  }
  return (
    `page ${oldId} at "${normalizedPath}" (locale "${locale}") already exists in the target site's ` +
    'tree — import failed for this page.'
  )
}

function describeStreamedNameRenameWarning(
  oldId: number,
  normalizedPath: string,
  locale: string,
  conflict: StreamedNameConflict,
  renamedPath: string
): string {
  const clash =
    conflict.reason === 'sibling-collision'
      ? `page ${conflict.claimedByOldId}, already imported earlier in this streaming run`
      : "an existing entry in the target site's tree"
  return (
    `page ${oldId}: normalized path "${normalizedPath}" (locale "${locale}") collided with ${clash} ` +
    `— imported instead at "${renamedPath}".`
  )
}

/**
 * `importOne()` never throws for a bad page, so a caller that unconditionally wrapped it as
 * `recorder.create()`'s `write` callback would misreport every failed page as a successful
 * `wouldCreate`. Routing on this outcome is what stops that.
 */
export type PageImportOutcome =
  | { status: 'created'; pageId: string }
  | { status: 'failed'; reason: PageImportFailureReason; message: string }

/** `succeeded`/`pageIdMap` are live references into the array/map each `importOne()` call mutates,
 * not snapshots. A failed page appears in neither — only in `importOne()`'s return value. */
export interface PageImporter {
  importOne(staged: StagedPage): Promise<PageImportOutcome>
  readonly succeeded: PageImportSuccess[]
  readonly pageIdMap: Map<number, string>
}

export function createPageImporter(
  deps: ImportPagesDeps,
  options: ImportPagesOptions
): PageImporter {
  const renderBootstrap = options.renderBootstrap ?? 'passthrough'
  const nowMillis = options.now ?? Date.now()

  const pageIdMap = new Map<number, string>()
  const succeeded: PageImportSuccess[] = []
  // -> Grows for the whole run, unlike the heavy StagedPage fields this streaming shape exists to
  //    avoid holding: three short strings per page is cheap enough to keep resident.
  const claimedLocations = new Map<string, number>()

  async function importOne(staged: StagedPage): Promise<PageImportOutcome> {
    const normalized = normalizeMigratedPath(staged.path)

    if ('reason' in normalized) {
      return { status: 'failed', reason: normalized.reason, message: normalized.message }
    }

    const resolved = await resolveStreamedFileName(
      options.siteId,
      staged.locale,
      normalized.parentPath,
      normalized.fileName,
      claimedLocations,
      deps.existingEntry
    )

    if (resolved.status === 'exhausted') {
      const message = describeStreamedNameConflictFailure(
        staged.oldId,
        normalized.path,
        staged.locale,
        resolved.conflict
      )
      return { status: 'failed', reason: resolved.conflict.reason, message }
    }

    const fileName = resolved.fileName
    const path = normalized.parentPath ? `${normalized.parentPath}/${fileName}` : fileName

    claimedLocations.set(
      streamedLocationKey(staged.locale, normalized.parentPath, fileName),
      staged.oldId
    )

    const assignment: TreePathAssignment = {
      oldId: staged.oldId,
      locale: staged.locale,
      parentPath: normalized.parentPath,
      fileName,
      path
    }

    const mapped = mapStagedPageToInput(
      staged,
      assignment,
      renderBootstrap,
      nowMillis,
      options.forcedPagePermissions
    )

    if (resolved.status === 'renamed') {
      mapped.warnings.push(
        describeStreamedNameRenameWarning(
          staged.oldId,
          normalized.path,
          staged.locale,
          resolved.conflict,
          path
        )
      )
    }

    let destId: string
    try {
      const created: Page = await deps.pagesModel.createPage(
        options.siteId,
        mapped.input,
        mapped.actor
      )
      destId = created.id
    } catch (err: any) {
      const message = `createPage() failed: ${err.message}`
      return { status: 'failed', reason: 'create-error', message }
    }

    pageIdMap.set(staged.oldId, destId)

    const pageWarnings = mapped.warnings

    if (deps.backfillHistory) {
      const historyResult = await deps.backfillHistory(staged, destId)
      pageWarnings.push(...historyResult.warnings)
      for (const historyFailure of historyResult.failed) {
        pageWarnings.push(
          `page ${staged.oldId}: pageHistory backfill failed — ${historyFailure.message}`
        )
      }
    }

    succeeded.push({
      oldId: staged.oldId,
      pageId: destId,
      warnings: pageWarnings,
      action: 'created'
    })
    return { status: 'created', pageId: destId }
  }

  return { importOne, succeeded, pageIdMap }
}
