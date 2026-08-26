import { IdMap } from './id-map.ts'
import { assignTreePaths } from './path-normalization.ts'
import type { PathAssignmentOptions, TreePathAssignment } from './path-normalization.ts'
import type { StagedPage } from './content-staging.ts'
import type { Page, PageActor, PageInput } from '../models/pages.ts'

/**
 * Page content import via `createPage()` (Feature 416 / Task 738)
 *
 * Turns each `StagedPage` this feature's staging pass (`content-staging.ts`, Task 733) produced into a
 * real 3.0 page, exclusively through `WIKI.models.pages.createPage(siteId, input, actor)`
 * (`backend/models/pages.ts:457`) — never a raw insert, per this task's own description, since
 * `createPage()` is also what writes the matching `tree` row, records the first `pageHistory` row and
 * indexes the page for search; duplicating any of that here would drift the moment `createPage()`
 * changes.
 *
 * Like every module in this feature so far, this one has no db access and is not wired to a CLI yet —
 * `WIKI.models.pages.createPage`/`queueRerender` and the tree existing-entry lookup are injected
 * (`ImportPagesDeps`), so tests exercise the real mapping/orchestration logic with fakes standing in for
 * both, and Task 421's CLI is what will eventually pass the real `WIKI.models.pages` /
 * `WIKI.models.tree` implementations here.
 *
 * `importPages()` calls Task 736's `assignTreePaths()` itself (rather than requiring the caller to run
 * it first) — that module's own doc comment names this task as the wiring point for the real
 * `WIKI.models.tree` lookup its `existingEntry` callback needs, so it is threaded straight through as
 * `ImportPagesDeps.existingEntry` rather than re-implemented here. A page whose path fails to normalize
 * or collides never reaches `createPage()` at all; it comes back as a `PageImportFailure` with the same
 * `reason` `assignTreePaths` gave it.
 *
 * ## The synthetic per-page actor
 *
 * `createPage()` has no field on `PageInput` for who authored/created a page — it hardcodes
 * `authorId: actor.id, creatorId: actor.id, ownerId: actor.id` to whoever is calling it. There is
 * therefore no way to hand it a *different* value for those three columns while still calling it as a
 * single operator identity for the whole run.
 *
 * To still carry the per-page identity `content-staging.ts` already resolved (`StagedPage.creatorId`,
 * itself falling back to the operator via `resolveActorId` wherever the source row's id was null or
 * unmapped — see `id-map.ts`), `importPages` builds one synthetic `PageActor` **per page** — `{ id:
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
 * `authorId` on every historical version is restored when Task 740 backfills `pageHistory` directly
 * (bypassing `createPage()`'s single-actor model, since `WIKI.models.pageHistory.record` — unlike
 * `createPage()` — takes an explicit `authorId`).
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
 *   - **`'queue'`**: create with an empty render, then call `pagesModel.queueRerender()` so the
 *     headless-browser `renderPages` job produces a native 3.0 render — correct output, using 3.0's own
 *     renderer, at the cost of queuing one browser render per page across the whole imported wiki, which
 *     is a real operational cost (time, and Puppeteer resource pressure) an operator importing a large
 *     wiki may want to skip and do gradually instead. Hence this being opt-in, not the default.
 *
 * `'passthrough'` is also what `docs/migration/2.5x-to-3.0-mapping.md` documents as the direct
 * `pages.render` → `pages.render` mapping, which is the other reason it is the default here rather than
 * `'queue'`.
 *
 * `queueRerender()` (`backend/models/pages.ts:907`, via `rendering.ensureCanRender`) only implements
 * server-side rendering for the `markdown` editor today — every other editor throws
 * `renderUnsupportedEditor`. Requesting `'queue'` for a non-markdown page therefore falls back to
 * `'passthrough'` for that page alone, with a warning, rather than failing it.
 *
 * ## `privateNS` / `isPrivate`
 *
 * Per `docs/migration/2.5x-to-3.0-mapping.md`, 3.0 `pages` has no `isPrivate`/`privateNS` column at
 * all — 2.x's boolean + private-namespace pair would need to become an equivalent page-rule permission
 * (a `read:pages` DENY/ALLOW/FORCEALLOW rule on `groups.rules`), which is #414 (Users, Groups &
 * Permissions)/#420 (Settings/Auth/Storage) territory, neither of which exists on this branch yet (see
 * this task's own continuity notes). Rather than drop the setting silently or fail the page, a page
 * carrying either one is imported (publicly readable, since there is currently nothing else 3.0 can do)
 * with a warning naming the gap, so an operator can add the equivalent rule by hand until #414/#420 wire
 * this up for real.
 */

/** The subset of `WIKI.models.pages` this module actually calls — injected so this module (and its
 * tests) never touch `WIKI` or a real database. See the module doc comment for why. */
export interface PagesWriteModel {
  createPage(siteId: string, input: PageInput, actor: PageActor): Promise<Page>
  queueRerender(siteId: string, id: string, actor: PageActor): Promise<boolean>
}

export interface ImportPagesDeps {
  pagesModel: PagesWriteModel
  /** Same contract as `PathAssignmentOptions.existingEntry` in `./path-normalization.ts` — threaded
   * straight through to `assignTreePaths`, which this module calls itself (see module doc comment). */
  existingEntry: PathAssignmentOptions['existingEntry']
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

export type PageImportFailureReason =
  | 'empty-path'
  | 'invalid-segment'
  | 'sibling-collision'
  | 'existing-entry-collision'
  | 'create-error'

export interface PageImportFailure {
  oldId: number
  path: string
  locale: string
  reason: PageImportFailureReason
  message: string
}

export interface PageImportSuccess {
  oldId: number
  /** The new 3.0 UUID `createPage()` returned — also recorded in `PageImportResult.pageIdMap`. */
  pageId: string
  /** Per-page notes (editor fallback, render-bootstrap downgrade, unmigrated privacy setting, the
   * authorId/creatorId collapse) — also folded into `PageImportResult.warnings`. */
  warnings: string[]
}

export interface PageImportResult {
  succeeded: PageImportSuccess[]
  failed: PageImportFailure[]
  /** Every per-page warning, in processing order, prefixed with the page it came from — the flat form
   * for whichever task ends up reporting import results to an operator (Task 421's CLI). */
  warnings: string[]
  /** old-`pages.id` → new-UUID, populated only for pages that actually got created — Task 740 resolves
   * `pageHistory.pageId` through this, per `content-staging.ts`'s `ContentStagingResult.pageIdMap` doc. */
  pageIdMap: IdMap<number>
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
 * Applies `normalizeStagedDate` to a staged `publishStartDate`/`publishEndDate`, which — unlike
 * `createdAt`/`updatedAt` — are already nullable at the staging layer (`content-staging.ts`'s
 * `asNullableString`). A non-empty value that fails to parse degrades to `null` (the column's
 * ordinary unset state) rather than reaching `createPage()`'s `new Date(...)` call, which would
 * build an Invalid Date and throw `RangeError: Invalid time value` when Drizzle's `timestamp`
 * mapper calls `.toISOString()` on it during the insert — losing the whole page instead of just
 * this one field. Unlike `createdAt`/`updatedAt`, a discard here also pushes a warning naming the
 * field and the discarded value, so the operator can go fix it at the source.
 */
function normalizeStagedPublishDate(
  field: 'publishStartDate' | 'publishEndDate',
  value: string | null,
  oldId: number,
  warnings: string[]
): string | null {
  if (!value) return null
  const normalized = normalizeStagedDate(value)
  if (normalized === undefined) {
    warnings.push(`page ${oldId}: ${field} "${value}" is not a valid date and was discarded.`)
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
    'rule), not a column, and is not wired up by #414/#420 on this branch yet. The page was imported ' +
    'publicly readable; add an equivalent page rule by hand until that lands.'
  )
}

interface MappedPage {
  input: PageInput
  actor: PageActor
  /** Whether `importPages` should call `queueRerender()` for this page after creation — see "The
   * render bootstrap decision". */
  queueRerender: boolean
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
        'so creatorId was used for all three — the real per-revision authorId is restored when Task 740 ' +
        'backfills pageHistory.'
    )
  }

  // -> 'queue' only actually works for the markdown editor today (queueRerender -> ensureCanRender
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
      'publishStartDate',
      staged.publishStartDate,
      staged.oldId,
      warnings
    ),
    publishEndDate: normalizeStagedPublishDate(
      'publishEndDate',
      staged.publishEndDate,
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
    queueRerender: canQueue,
    warnings
  }
}

/**
 * Imports every staged page into `siteId` via `createPage()`, per this task's description. Normalizes
 * every page's tree location first (Task 736's `assignTreePaths`); a page that fails to normalize or
 * collides never reaches `createPage()`. Never throws for one bad or colliding page — each becomes a
 * `PageImportFailure` instead, so one page's bad data cannot abort the whole run.
 */
export async function importPages(
  pages: StagedPage[],
  deps: ImportPagesDeps,
  options: ImportPagesOptions
): Promise<PageImportResult> {
  const renderBootstrap = options.renderBootstrap ?? 'passthrough'
  const nowMillis = options.now ?? Date.now()

  const warnings: string[] = []
  const pageIdMap = new IdMap<number>()
  const succeeded: PageImportSuccess[] = []
  const failed: PageImportFailure[] = []

  const pathResult = await assignTreePaths(
    pages.map((page) => ({ oldId: page.oldId, path: page.path, locale: page.locale })),
    { siteId: options.siteId, existingEntry: deps.existingEntry }
  )

  for (const failure of pathResult.failures) {
    failed.push({
      oldId: failure.oldId,
      path: failure.path,
      locale: failure.locale,
      reason: failure.reason,
      message: failure.message
    })
  }

  const assignmentByOldId = new Map(pathResult.assignments.map((a) => [a.oldId, a]))

  for (const staged of pages) {
    const assignment = assignmentByOldId.get(staged.oldId)
    // -> No assignment means this page already came back as a path failure above.
    if (!assignment) continue

    const mapped = mapStagedPageToInput(
      staged,
      assignment,
      renderBootstrap,
      nowMillis,
      options.actorPermissions
    )

    let created: Page
    try {
      created = await deps.pagesModel.createPage(options.siteId, mapped.input, mapped.actor)
    } catch (err: any) {
      failed.push({
        oldId: staged.oldId,
        path: staged.path,
        locale: staged.locale,
        reason: 'create-error',
        message: `createPage() failed: ${err.message}`
      })
      continue
    }

    pageIdMap.set(staged.oldId, created.id)

    const pageWarnings = mapped.warnings
    if (mapped.queueRerender) {
      try {
        await deps.pagesModel.queueRerender(options.siteId, created.id, mapped.actor)
      } catch (err: any) {
        pageWarnings.push(
          `page ${staged.oldId}: queueRerender() failed after creation — the page was created with an ` +
            `empty render and needs a manual re-render: ${err.message}`
        )
      }
    }

    warnings.push(...pageWarnings)
    succeeded.push({ oldId: staged.oldId, pageId: created.id, warnings: pageWarnings })
  }

  return { succeeded, failed, warnings, pageIdMap }
}
