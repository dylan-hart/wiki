import { normalizeMigratedPath } from '../path-normalization.ts'
import type { PathAssignmentOptions, TreePathAssignment } from '../path-normalization.ts'
import type { StagedPage } from '../content-staging.ts'
import type { PageHistoryImportResult } from './page-history-import.ts'
import type { Page, PageActor, PageInput } from '../../models/pages.ts'
import { MAX_NAME_ATTEMPTS } from '../../models/tree.ts'

/**
 * Page content import via `createPage()`
 *
 * Turns each `StagedPage` the staging pass (`../content-staging.ts`'s `extractContentStaging()`
 * generator) produces into a real 3.0 page, exclusively through
 * `WIKI.models.pages.createPage(siteId, input, actor)` — never a raw insert, since `createPage()` is
 * also what writes the matching `tree` row, records the first `pageHistory` row and indexes the page
 * for search; duplicating any of that here would drift the moment `createPage()` changes.
 *
 * This module has no db access of its own: `WIKI.models.pages.createPage`, the tree existing-entry
 * lookup, and the per-page history backfill are all injected (`ImportPagesDeps`), so tests exercise
 * the real mapping/orchestration logic with fakes standing in for each. `phases/content.ts` passes
 * the real implementations (dry-run-gated).
 *
 * `importOne()` normalizes and collision-checks each page's tree location itself, via
 * `../path-normalization.ts`'s `normalizeMigratedPath()`, rather than requiring the caller to run it
 * first — its `existingEntry` callback is threaded straight through as
 * `ImportPagesDeps.existingEntry` rather than re-implemented here. A page whose path fails to
 * normalize or collides never reaches `createPage()` at all; it comes back as a `'failed'`
 * `PageImportOutcome` with the same `reason` `normalizeMigratedPath()`/the collision check below gave
 * it.
 *
 * ## Streaming input and per-page sibling-collision detection
 *
 * Pages arrive one at a time through `importOne()`, rather than as a `StagedPage[]` materialized up
 * front — this is what lets `extractContentStaging()`'s streaming generator hand pages over one at a
 * time instead of buffering the whole corpus. Each page is fully
 * processed (path-assigned, created, its history backfilled — see below) before the caller pulls the
 * next one off the source, so at most one page's heavy fields (`content`/`render`/`toc`/history
 * `content`) are resident at a time.
 *
 * That single-pass shape constrains sibling-collision semantics: by the time a later page is
 * discovered to collide with an earlier one, the earlier page has already been created, so there is no
 * "fail both sides" available. `createPageImporter()` therefore tracks each
 * `(locale, parentPath, fileName)` it has already claimed in a `Map` as it goes; a later page that
 * lands on an already-claimed location does NOT fail immediately — `resolveStreamedFileName()` retries
 * with a numeric suffix appended to the normalized `fileName` (`name-1`, `name-2`, …), re-checking both
 * `claimedLocations` and `deps.existingEntry()` for each candidate, the same dedupe
 * `models/tree.ts#resolveName`'s `onConflict: 'suffix'` branch already applies for assets — including
 * its `MAX_NAME_ATTEMPTS` cap, imported from there rather than duplicated. A page that lands on a free
 * suffixed name is created under that name with a warning noting the rename; only a page that collides
 * on every attempt up to the cap fails (`'sibling-collision'`, naming the earlier, already-created page
 * that was kept instead).
 *
 * A page whose unsuffixed name collides with a pre-existing 3.0 tree entry instead — an
 * `'existing-entry-collision'` — is deliberately NOT retried with a suffix at all, and fails
 * immediately exactly as before this dedupe existed. See `resolveStreamedFileName()`'s own doc comment
 * for why: `phases/content.ts` relies on that exact reason meaning "this page already exists at the
 * destination" to safely skip it (not fail the run) when the migration CLI is re-run after an
 * interrupted earlier attempt — a numeric-suffix rename there would silently create a duplicate of an
 * already-migrated page instead.
 *
 * ## History backfill, interleaved
 *
 * Immediately after a page is created (and any render-queue it triggered has been requested —
 * `createPage()`'s own concern, see "The render bootstrap decision" below), `importOne()` calls
 * `./page-history-import.ts`'s `backfillPageHistoryForPage()` for that one page's `history` chain alone —
 * resolving `pageIdMap` for a single freshly-created page rather than waiting for the whole run, via
 * `ImportPagesDeps.backfillHistory`. This is what "page 1's history lands before page 2 is even staged"
 * means in practice: nothing about page 2 is pulled from the source until page 1's
 * create-and-backfill has already finished. A history-insert failure for one page is folded into that
 * page's own warnings rather than turned into a failed outcome — the page itself was created
 * successfully; only some of its past revisions may be missing, the same "non-fatal, reported as a
 * warning" treatment already given to an editor fallback or a render-bootstrap downgrade. This keeps
 * every source page accounted for exactly once, in exactly one of created/failed, and means one
 * page's history failure neither aborts the run nor loses any other page's rows.
 *
 * ## The synthetic per-page actor
 *
 * `createPage()` has no field on `PageInput` for who authored/created a page — it hardcodes
 * `authorId: actor.id, creatorId: actor.id, ownerId: actor.id` to whoever is calling it. There is
 * therefore no way to hand it a *different* value for those three columns while still calling it as a
 * single operator identity for the whole run.
 *
 * To still carry the per-page identity `content-staging.ts` already resolved (`StagedPage.creatorId`,
 * itself falling back to the operator wherever the source row's id was null or unmapped),
 * `importOne()` builds one synthetic `PageActor` **per page** — `{ id:
 * staged.creatorId, permissions: options.actorPermissions }` — rather than one fixed actor for every
 * call. Only `permissions` (which gates the `write:scripts`/`write:styles` checks `postProcess` makes)
 * comes from the operator's own grant; a migration is not "logged in as" each original 2.x author, so
 * using the actual (possibly unprivileged, possibly nonexistent) author's permissions would make the
 * result depend on who happened to write the page in 2.x rather than on what the operator running the
 * import is entitled to carry across.
 *
 * `StagedPage.authorId` (2.x's *last editor*, as opposed to `creatorId`'s *original author*) has
 * nowhere to land on the row `createPage()` produces — the call collapses both onto `creatorId`. A page
 * whose `authorId` differs from its `creatorId` gets a warning noting the collapse; the real per-revision
 * `authorId` on every historical version is restored by `./page-history-import.ts`, which inserts
 * `pageHistory` rows directly and so is not bound by `createPage()`'s single-actor model.
 *
 * ## The render bootstrap decision
 *
 * Per the feature brief, there are two ways to seed a newly-created page's render/TOC/search index:
 *
 *   - **`'passthrough'` (the default)**: pass 2.x's already-stored `render` HTML straight through as
 *     `input.render`. `createPage()`'s call to `WIKI.models.rendering.postProcess` sanitizes it and
 *     extracts `toc`/`searchContent` from it immediately, so the page is fully readable and searchable
 *     the instant it's created — at the cost of that HTML reflecting 2.x's markdown-it plugin output
 *     (2.x's renderer, 2.x's plugin set) until the page is next edited or explicitly re-rendered.
 *   - **`'queue'`**: leave `input.render` undefined, which `createPage()` itself
 *     recognizes as "content with nothing to show for it" — it confirms up front that this instance can
 *     render the page at all, creates it, then queues the same headless-browser `renderPages` job a
 *     stale stored page would get, producing a native 3.0 render — correct output, using 3.0's own
 *     renderer, at the cost of queuing one browser render per page across the whole imported wiki, which
 *     is a real operational cost (time, and Puppeteer resource pressure) an operator importing a large
 *     wiki may want to skip and do gradually instead. Hence this being opt-in, not the default.
 *
 * `'passthrough'` is also what `docs/migration/2.5x-to-3.0-mapping.md` documents as the direct
 * `pages.render` → `pages.render` mapping, which is the other reason it is the default here rather than
 * `'queue'`.
 *
 * `createPage()`'s render-queue path (`backend/models/pages.ts`, via `rendering.ensureCanRender`) only
 * implements server-side rendering for the `markdown` editor today — every other editor throws
 * `renderUnsupportedEditor`. Requesting `'queue'` for a non-markdown page therefore falls back to
 * `'passthrough'` for that page alone, with a warning, rather than failing it (see `canQueue` below).
 *
 * ## `privateNS` / `isPrivate`
 *
 * Per `docs/migration/2.5x-to-3.0-mapping.md`, 3.0 `pages` has no `isPrivate`/`privateNS` column at
 * all — 2.x's boolean + private-namespace pair would need to become an equivalent page-rule permission
 * (a `read:pages` DENY/ALLOW/FORCEALLOW rule on `groups.rules`), and nothing derives one: the source
 * has no group to attach it to, and the `users` phase imports only the rules a source group already
 * carried. Rather than drop the setting silently or fail the page, a page carrying either one is
 * imported (publicly readable) with a warning naming the gap, so an operator can add the equivalent
 * rule by hand.
 */

/** The subset of `WIKI.models.pages` this module actually calls — injected so this module (and its
 * tests) never touch `WIKI` or a real database. See the module doc comment for why. */
export interface PagesWriteModel {
  createPage(siteId: string, input: PageInput, actor: PageActor): Promise<Page>
}

export interface ImportPagesDeps {
  pagesModel: PagesWriteModel
  /** Same contract as `PathAssignmentOptions.existingEntry` in `./path-normalization.ts` — threaded
   * straight through to the per-page collision check this module runs itself (see module doc
   * comment's "Streaming input and per-page sibling-collision detection"). */
  existingEntry: PathAssignmentOptions['existingEntry']
  /**
   * Called immediately after a page is created — before the next page is even pulled off `pages` —
   * to backfill that page's whole 2.x `pageHistory` chain. The real
   * implementation wires this straight to `page-history-import.ts`'s
   * `backfillPageHistoryForPage(staged, newPageId, siteId, deps)`; a caller that doesn't care about
   * history at all (or a test exercising something else) can omit it, which skips backfill entirely
   * — the importer never calls history backfill on its own. Its `PageHistoryImportResult.failed`
   * is folded into that page's own `warnings`, never aborting the page it belongs to (which already
   * succeeded by the time this runs) or any other page.
   */
  backfillHistory?: (page: StagedPage, newPageId: string) => Promise<PageHistoryImportResult>
}

export interface ImportPagesOptions {
  /** The 3.0 site being imported into. */
  siteId: string
  /** The operator's own permission grant, used for every synthetic per-page actor's `write:scripts` /
   * `write:styles` checks — see "The synthetic per-page actor" in the module doc comment. */
  actorPermissions: string[]
  /** See "The render bootstrap decision" in the module doc comment. Defaults to `'passthrough'`. */
  renderBootstrap?: 'passthrough' | 'queue'
  /** Epoch milliseconds to treat as "now" when deriving `publishState` — injectable for deterministic
   * tests; defaults to `Date.now()`. */
  now?: number
}

/**
 * - `'sibling-collision'`: the page's normalized `(locale, parentPath, fileName)` clashed with an
 *   earlier page already imported in this same streaming run — and, per `resolveStreamedFileName()`
 *   (see the module doc comment), every `name-1`, `name-2`, … numeric-suffix retry up to
 *   `MAX_NAME_ATTEMPTS` (`models/tree.ts`) *also* collided. This no longer fires on the first
 *   collision — only once the whole retry budget is exhausted with no free name found.
 * - `'existing-entry-collision'`: the page's normalized location already holds a pre-existing 3.0
 *   tree entry. Unlike `'sibling-collision'`, this still fires immediately, with no suffix retried at
 *   all — `phases/content.ts` relies on this exact reason to classify a page as an idempotent skip
 *   (already migrated) rather than a failure when the CLI is re-run after an interrupted attempt; see
 *   `resolveStreamedFileName()`'s own doc comment.
 */
export type PageImportFailureReason =
  | 'empty-path'
  | 'invalid-segment'
  | 'sibling-collision'
  | 'existing-entry-collision'
  | 'create-error'

export interface PageImportSuccess {
  oldId: number
  /** The 3.0 UUID this page now maps to — freshly created by `createPage()`. Also recorded in
   * `PageImporter.pageIdMap`. */
  pageId: string
  /** Per-page notes (editor fallback, render-bootstrap downgrade, unmigrated privacy setting, the
   * authorId/creatorId collapse). */
  warnings: string[]
  /** Fixed at `'created'` — the destination is always empty, so there is no existing page to skip. */
  action: 'created'
}

/** What each recognized 2.x `editorKey` becomes in 3.0 — `pages.ts`'s own `EDITOR_CONTENT_TYPES` keys
 * are exactly the set of editors 3.0 gives first-class meaning to, so they pass straight through;
 * `ckeditor` is 2.x's actual WYSIWYG editor key and maps onto 3.0's `wysiwyg`. */
const EDITOR_KEY_MAP: Record<string, string> = {
  markdown: 'markdown',
  asciidoc: 'asciidoc',
  wysiwyg: 'wysiwyg',
  ckeditor: 'wysiwyg',
  redirect: 'redirect'
}

/** Fallback source when `editorKey` itself has no 3.0 equivalent (or is absent): 2.x's `contentType`
 * sometimes still names something recognizable. */
const CONTENT_TYPE_EDITOR_HINT: Record<string, string> = {
  markdown: 'markdown',
  asciidoc: 'asciidoc',
  html: 'wysiwyg',
  redirect: 'redirect'
}

/** The editor a page falls back to when neither `editorKey` nor `contentType` name anything 3.0
 * recognizes. Content is preserved byte-for-byte regardless — this only picks which editor UI the page
 * opens in afterwards. */
const DEFAULT_FALLBACK_EDITOR = 'markdown'

/**
 * Maps a staged page's `editorKey` (falling back to `contentType`) onto a 3.0 `editor` value, per the
 * `EDITOR_CONTENT_TYPES` map `createPage()` itself re-derives `contentType` from. Pushes a warning onto
 * `warnings` whenever `editorKey` was present but not one 3.0 recognizes — whether or not `contentType`
 * let this recover a sensible editor anyway — per this task's description: flag it, don't just silently
 * carry on.
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
 * Validates a staged `createdAt`/`updatedAt` string before it is handed to `PageInput` — `Date.parse`
 * rather than `new Date(...)` because the latter never throws even for garbage input, it just becomes
 * an `Invalid Date` that `createPage()` would try to insert. Malformed source data degrades to `undefined`
 * (the column's ordinary `now()` default) rather than failing the whole page's import, the same
 * tolerance `page-history-import.ts`'s `parseVersionDate` gives a malformed `versionDate`.
 */
function normalizeStagedDate(value: string): string | undefined {
  return Number.isNaN(Date.parse(value)) ? undefined : value
}

/**
 * Same validation as `normalizeStagedDate`, applied to a nullable field where `null` is itself a
 * normal, already-valid source value (no date set) rather than something to warn about — only a
 * non-empty value that fails to parse is a data problem worth surfacing to the operator. Used for
 * `publishStartDate`/`publishEndDate`, which — unlike `createdAt`/`updatedAt` — previously skipped
 * `normalizeStagedDate` entirely and were passed to `createPage()` raw (OpenProject #1845/#1853).
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
 * Derives 3.0's three-state `publishState` from 2.x's `isPublished` boolean plus its
 * `publishStartDate`/`publishEndDate` pair, per `docs/migration/2.5x-to-3.0-mapping.md`'s "2.x's
 * boolean + the publishStartDate/publishEndDate pair together decide which of the three 3.0 enum states
 * applies."
 *
 *   - `isPublished` false → `'draft'`, regardless of any dates (2.x never rendered it either).
 *   - `isPublished` true, no dates set → `'published'` (live now, unconditionally, exactly as 2.x had it).
 *   - `isPublished` true, one or both dates set → `'published'` if `now` actually falls inside the
 *     window, `'scheduled'` otherwise — covering both "hasn't started yet" and "already ended", since
 *     3.0 has no distinct "expired" state and `updatePage`'s own guard only requires *some* date to be
 *     present for `'scheduled'`, not specifically a future start.
 *
 * A date string that fails to parse is treated as absent rather than thrown on — malformed source data
 * should degrade the derivation, not abort the page.
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

/**
 * Notes 2.x's `isPrivate`/`privateNS` when either is set — see "`privateNS` / `isPrivate`" in the
 * module doc comment. Returns `null` for an ordinary, non-private page.
 */
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
  actorPermissions: string[]
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

  // -> 'queue' only actually works for the markdown editor today (createPage()'s own ensureCanRender
  //    throws renderUnsupportedEditor for anything else) — fall back per-page rather than failing the
  //    page over a render-bootstrap preference.
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
    // -> Preserve the source page's real timestamps instead of createPage()'s ordinary now() default —
    //    see PageInput.createdAt/updatedAt's doc comment (backend/models/pages.ts) and upstream
    //    requarks/wiki#4631, the bug this exists to not repeat.
    createdAt: normalizeStagedDate(staged.createdAt),
    updatedAt: normalizeStagedDate(staged.updatedAt)
  }

  return {
    input,
    actor: { id: staged.creatorId, groupIds: [], permissions: actorPermissions },
    warnings
  }
}

/** Builds the `Map` key one `(locale, parentPath, fileName)` tree location collapses to for the
 * per-page sibling-collision check — see the module doc comment. A space is a safe separator here
 * because each of the three parts is either a locale code or already folded to `RE_FOLDER_SEGMENT`
 * (`path-normalization.ts`), so none of them can contain one. */
function streamedLocationKey(locale: string, parentPath: string, fileName: string): string {
  return `${locale} ${parentPath} ${fileName}`
}

/** What blocked one candidate `fileName` from being claimed — either an earlier page in this same
 * streaming run (`claimedByOldId` names it), or a pre-existing 3.0 tree entry. */
interface StreamedNameConflict {
  reason: 'sibling-collision' | 'existing-entry-collision'
  claimedByOldId?: number
}

/** Checks one candidate `(locale, parentPath, fileName)` against `claimedLocations` first (cheap, in
 * memory), then `existingEntry` (the injected tree lookup) — `null` when the candidate is free to
 * claim. Used by `resolveStreamedFileName()` both for the unsuffixed name and every `name-N` retry. */
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
 * Finds a `fileName` this page may claim at `(locale, parentPath)` — the normalized name itself if
 * free, otherwise `name-1`, `name-2`, … numeric-suffix retries up to `MAX_NAME_ATTEMPTS`
 * (`models/tree.ts`, the same cap `resolveName`'s `onConflict: 'suffix'` branch uses for assets), each
 * re-checked against both `claimedLocations` and `existingEntry`.
 *
 * Only a `'sibling-collision'` on the unsuffixed name — two different staged pages in *this same
 * streaming run* folding to the same location — enters that retry loop. An `'existing-entry-collision'`
 * on the unsuffixed name is deliberately left `'exhausted'` immediately, with no suffix tried at all:
 * `phases/content.ts#toRecordOutcome()` relies on this exact reason meaning "this page already exists
 * at the destination" to safely classify it as an idempotent skip (not a failure) when the migration
 * CLI is re-run after an earlier attempt was interrupted partway through — renaming it into
 * `name-1` would instead create a genuine duplicate of an already-migrated page. See
 * `content.integration.test.ts`'s "correctly skipping a page that already exists at the destination".
 *
 * A *suffixed* candidate colliding against `existingEntry` mid-retry is a different situation — that
 * name was never this page's own canonical target, so there is no idempotency signal to preserve —
 * and is simply treated as unavailable, same as a suffixed `claimedLocations` hit, so the loop moves on
 * to the next candidate.
 *
 * `'exhausted'` is returned only once every attempt up to the cap has also collided — its `conflict`
 * is always the *first* one seen (the unsuffixed name's own sibling-collision), which is what actually
 * explains why this page can't land: a suffixed candidate conflicting for a different reason doesn't
 * change the underlying story, only whether a free name was eventually found.
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

/** Describes what blocked `oldId`'s page for good, once `resolveStreamedFileName()` reports
 * `'exhausted'` — the failure message for `PageImportOutcome`. Only a `'sibling-collision'` ever
 * actually went through suffix retries first (see `resolveStreamedFileName()`); an
 * `'existing-entry-collision'` message reads exactly as it always has, with no mention of retries it
 * never attempted. */
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

/** Notes that a page's normalized path collided and was renamed via a numeric suffix instead of being
 * dropped — pushed onto the page's own `warnings` alongside every other per-page note. */
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
 * What one `importOne()` call resolved to — see `phases/content.ts`'s `toRecordOutcome()`, which
 * mirrors `phases/users.ts`'s `routeOutcome()` convention. `importOne()` never throws for a bad page
 * (a sibling-collision, an existing-entry-collision, a `createPage()` error), so a caller that
 * unconditionally wrapped it as `recorder.create()`'s `write` callback would misreport every failed
 * page as a successful `wouldCreate` — routing on this outcome is what stops that.
 *
 * Success carries the new page id (already recorded in `pageIdMap` before this returns); failure
 * carries the `reason`/`message` describing what went wrong, so a caller has everything it needs to
 * report the page without any separate failure bookkeeping.
 */
export type PageImportOutcome =
  | { status: 'created'; pageId: string }
  | { status: 'failed'; reason: PageImportFailureReason; message: string }

/** Live, streaming per-page import: one `StagedPage` at a time, driven from a phase-classify callback
 * rather than handed a whole iterable up front. `succeeded`/`pageIdMap` are live references into the
 * same array/map every `importOne()` call mutates — not snapshots — so a caller reading them after
 * several calls sees every page processed so far. A failed page is reported through `importOne()`'s
 * own return value alone (see `PageImportOutcome`). See the module doc comment's "Streaming input and
 * per-page sibling-collision detection" and "History backfill, interleaved" for what `importOne()`
 * does and why. */
export interface PageImporter {
  importOne(staged: StagedPage): Promise<PageImportOutcome>
  readonly succeeded: PageImportSuccess[]
  readonly pageIdMap: Map<number, string>
}

/**
 * Builds a `PageImporter` for one import run against `siteId`. Never throws for one bad, colliding, or
 * history-failing page — each comes back as a `'failed'` `PageImportOutcome` (or a warning on an
 * otherwise-successful page) instead, so one page's bad data cannot abort the whole run.
 */
export function createPageImporter(
  deps: ImportPagesDeps,
  options: ImportPagesOptions
): PageImporter {
  const renderBootstrap = options.renderBootstrap ?? 'passthrough'
  const nowMillis = options.now ?? Date.now()

  const pageIdMap = new Map<number, string>()
  const succeeded: PageImportSuccess[] = []
  // -> Every tree location already claimed by an earlier page in this stream, oldId → key. Lightweight
  //    by construction (three short strings per page) — safe to keep resident for the whole run, unlike
  //    the heavy StagedPage fields this streaming shape exists to avoid holding onto.
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
      options.actorPermissions
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
      // -> Immediately after this page's own createPage() — before the next page is even pulled off
      //    `pages` — so a large corpus's history lands interleaved with page creation rather than
      //    buffered until the whole run's pages exist. See ImportPagesDeps.backfillHistory.
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
