import type { SourceConnector, SourceRecord } from './connector.ts'
import { resolveActorId, type UserIdMap } from './id-map.ts'
// -> Type-only, so this is erased entirely at load time (verbatimModuleSyntax) -- safe even though
//    navigation-import.ts imports StagedNavigation back from this module, since neither import
//    survives to become a real runtime circular dependency.
import type { NavigationPageRef } from './importers/navigation-import.ts'
import { coerceSourceBoolean } from './source-coercion.ts'

/**
 * Content staging & id-mapping scaffold (Feature 416 / Task 733; streamed per WP #1790 / Task #1798)
 *
 * The read side this feature owns: walks a connected `SourceConnector`'s `pages()`, `pageHistory()`
 * and `navigation()` generators and produces one `StagedPage` at a time, joined to its locale-variant
 * siblings and its full history chain, with tags already resolved to plain strings and
 * `authorId`/`creatorId` already resolved to 3.0 UUIDs (falling back to the operator running the
 * import wherever the source id is missing or unmapped).
 *
 * Deliberately does **not** write anything — no `createPage()`, no db access at all. This is staging
 * only; turning a `StagedPage` into a real 3.0 page (Task 738), backfilling its history (Task 740),
 * normalizing its path into a `tree` folderPath (Task 736) and importing the site-wide menu (Task 741)
 * are each a separate task's job, consuming this module's output.
 *
 * Tag resolution relies on `pages()`/`pageHistory()` rows already carrying a denormalized `tags`
 * field — `[{tag, title}]`, matching `docs/migration/2.5x-export-bundle-format.md`'s documented
 * `pages.json.gz`/`pages-history.json.gz` row shape — because the `SourceConnector` interface has no
 * separate `pageTags()`/`pageHistoryTags()` generator to join against here. `PostgresSourceConnector`
 * reproduces the same shape via a SQL join so both connector kinds hand this module identical input.
 *
 * ## Streaming shape (WP #1790)
 *
 * Orphan classification (`orphanedHistory`) needs to know about every page in the source before it
 * can be answered for even one page: it decides orphanhood precisely by failing to find a
 * `pageHistory` row's `pageId` among *every* current page. It does not, though, need anything about a
 * page beyond its `oldId` — so `buildContentStagingIndex()` walks `connector.pages()` once up front to
 * build exactly that (an `oldId` set), and `extractContentStaging()` then walks `connector.pages()` a
 * *second* time, this time building the full `StagedPage` (with `content`/`render`/`toc`) one page at
 * a time and yielding it immediately — nothing beyond the lightweight index and the current page's
 * own data is ever resident together.
 *
 * `pageHistory()` is merged in via a merge-join against the same walk, relying on `PostgresSourceConnector`
 * yielding it `ORDER BY "pageId"` (documented on `pageHistory()` in `connector.ts`) — the same order
 * `pages()` yields by `id`. A row whose `pageId` sorts out of step with that (only possible on a
 * connector that does not uphold the documented ordering) is warned about and dropped rather than
 * mis-attached to the wrong page.
 *
 * WP #1798 independently targeted this same "don't buffer the whole corpus" goal from an older base,
 * before the `buildContentStagingIndex()`/`ContentStagingIndex` split above had landed — its
 * alternative shape (a single `extractContentStaging()` returning a `ContentStagingResult` wrapper,
 * with the pre-pass folded inside) was superseded by the two-call `buildContentStagingIndex()` +
 * `extractContentStaging(connector, options, index, context)` design here rather than merged in.
 */

/** A 2.x tag string, resolved (from `pageTags`/`pageHistoryTags` via `tags.tag`) rather than left as
 * a bare `tagId` — see the module doc comment above for where the resolution actually happens. */
export type StagedTag = string

export interface StagedPageHistoryEntry {
  /** The 2.x `pageHistory.id` this row came from — what a page-history id map (built the same way as
   * `page-import.ts`'s `pageIdMap`, by whichever task actually inserts these rows) keys off. */
  oldId: number
  action: string
  path: string
  locale: string
  title: string
  description: string | null
  content: string | null
  contentType: string
  isPrivate: boolean
  isPublished: boolean
  publishStartDate: string | null
  publishEndDate: string | null
  editorKey: string | null
  /** Copied verbatim from the source row — see `2.5x-source-schema.md`'s note that recomputing the
   * `2.2.17.js` backfill self-join is unnecessary for a straight migration. */
  versionDate: string
  createdAt: string
  extra: Record<string, unknown>
  tags: StagedTag[]
  /** Resolved 3.0 UUID — the operator fallback if the 2.x row's `authorId` was null or unmapped. */
  authorId: string
}

/** A `pageHistory` row whose `pageId` names no page among the source's current `pages` rows — a
 * deleted 2.x page, whose history is meant to outlive it (`2.5x-source-schema.md`: `pageHistory.pageId`
 * is "a plain column with no FK constraint ... rows are meant to outlive the page they belonged to").
 * Kept separately from `StagedPage.history` because there is no `StagedPage` to attach it to. */
export interface OrphanedPageHistoryEntry extends StagedPageHistoryEntry {
  /** The 2.x `pageHistory.pageId` value that named no current page. */
  sourcePageOldId: number
}

export interface StagedPage {
  /** The 2.x `pages.id` this row came from — what `page-import.ts`'s `PageImporter.pageIdMap` is
   * keyed on once `importOne()` calls `createPage()` for it. */
  oldId: number
  path: string
  locale: string
  title: string
  description: string | null
  content: string | null
  render: string | null
  toc: unknown
  contentType: string
  isPrivate: boolean
  privateNS: string | null
  isPublished: boolean
  publishStartDate: string | null
  publishEndDate: string | null
  createdAt: string
  updatedAt: string
  extra: Record<string, unknown>
  editorKey: string | null
  tags: StagedTag[]
  /** Resolved 3.0 UUIDs — the operator fallback wherever the 2.x row's id was null or unmapped. */
  authorId: string
  creatorId: string
  /** This page's full revision chain, ordered by `versionDate` ascending (oldest first). */
  history: StagedPageHistoryEntry[]
}

/** 2.x's single `navigation` row (or rows — the source table is string-keyed, and while `'site'` is
 * the only key ever written in practice, per Feature 412's own description, nothing here assumes
 * there is exactly one), carried through with its JSON tree untouched. */
export interface StagedNavigation {
  key: string
  /** The parsed `navigation.config` JSON tree, verbatim — `docs/migration/2.5x-to-3.0-mapping.md`
   * explicitly leaves the internal shape of this tree unverified at the column-mapping level; turning
   * it into 3.0 `navigation.items` is Task 741's job. */
  items: unknown
}

/**
 * The lightweight pre-pass this feature's streaming walk needs before it can emit even its first
 * `StagedPage` — see "Streaming shape" in the module doc comment. Built once by
 * `buildContentStagingIndex()` and handed to `extractContentStaging()` for orphan classification.
 */
export interface ContentStagingIndex {
  /** Every page's `oldId` — what orphan classification tests membership against in O(1), without
   * needing the full `StagedPage` map the pre-streaming implementation kept resident to answer the
   * same question. An `oldId` costs a few bytes; keeping every page's worth of them resident for the
   * whole run is not the same problem as keeping every page's `content`/`render`/`toc` resident, which
   * is what this feature exists to stop doing. */
  pageOldIds: Set<number>
}

/**
 * The mutable, run-scoped side channel `extractContentStaging()` writes into as it streams — since an
 * async generator's return value is discarded by `for await`, warnings and orphaned history (both
 * unknowable in full until the whole `pageHistory()` stream has been drained, which only happens once
 * every page has been yielded) are collected here instead, for the caller to read once iteration
 * finishes. Build one with `createContentStagingContext()` per run.
 */
export interface ContentStagingContext {
  /** Human-readable notes on data that could not be carried across faithfully — currently: an
   * orphaned `authorId`/`creatorId` FK (present in the source, unmapped by `userIdMap`) that fell back
   * to the operator actor, and a `pageHistory` row that named no current page. Surfaced for whichever
   * task ends up reporting import results to an operator (Task 421's CLI) rather than acted on here. */
  warnings: string[]
  /** `pageHistory` rows whose `pageId` matched no row in `pages` — see `OrphanedPageHistoryEntry`.
   * Only complete once the `extractContentStaging()` generator that was given this context has been
   * fully drained — sorted by `versionDate` ascending at that point, same as before streaming. */
  orphanedHistory: OrphanedPageHistoryEntry[]
  /** Every staged page's lightweight `{oldId, path, locale}` identity (Task 13, WP #1790), appended to
   * as `extractContentStaging()` yields each `StagedPage` — what `navigation-import.ts`'s
   * `importNavigation()` needs to resolve a 2.x `'page'`-type nav target back onto a staged page.
   * Complete once every page this run's `pages` entity yielded has actually been processed by its
   * caller (`phases/content.ts`'s streaming `pages` entity fully drains before its `navigation` entity
   * starts — see that file's own doc comment), the same "complete once the whole walk has finished"
   * contract `orphanedHistory` already has, just driven by the consumer finishing the generator rather
   * than the generator itself finishing internally. */
  stagedPageRefs: NavigationPageRef[]
}

export function createContentStagingContext(): ContentStagingContext {
  return { warnings: [], orphanedHistory: [], stagedPageRefs: [] }
}

export interface ContentStagingOptions {
  /** #414's old-`users.id` → new-UUID map. See `UserIdMap` in `./id-map.ts` for the contract this
   * feature actually depends on. */
  userIdMap: UserIdMap
  /** The 3.0 UUID of the actor `resolveActorId` falls back to — this task's chosen strategy for 2.x's
   * nullable/orphaned `authorId`/`creatorId` against 3.0's NOT NULL columns is "the operator running
   * the import"; resolving *who* that is (or creating a system account for it) is left to whichever
   * task wires this module up (Task 421's CLI), which is why it is a plain required UUID here rather
   * than something this module resolves itself. */
  fallbackActorId: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function asString(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value)
}

/** Widened past a strict `=== true` (Task 1850) — see `coerceSourceBoolean`'s doc comment for why a
 * bundle-sourced 0/1 has to coerce the same as the Postgres connector's real boolean. A value this
 * doesn't recognize (missing column, malformed row) falls back to `false` rather than throwing,
 * matching this function's pre-1850 total behavior. */
function asBoolean(value: unknown): boolean {
  return coerceSourceBoolean(value) === true
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function requireNumber(value: unknown, field: string): number {
  const num = asNullableNumber(value)
  if (num === null) {
    throw new Error(`Source row is missing required numeric field "${field}".`)
  }
  return num
}

/** Normalizes a `[{tag, title}]` (the shape both connector kinds denormalize onto — see the module
 * doc comment) down to plain tag strings, dropping anything malformed rather than throwing: a
 * migration's staging pass should surface bad rows as warnings elsewhere, not abort on one bad tag. */
function resolveTags(value: unknown): StagedTag[] {
  if (!Array.isArray(value)) return []
  const tags: StagedTag[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      tags.push(entry)
    } else if (entry && typeof entry === 'object' && 'tag' in entry) {
      const tag = (entry as { tag: unknown }).tag
      if (typeof tag === 'string' && tag.length > 0) tags.push(tag)
    }
  }
  return tags
}

function stagePage(
  raw: SourceRecord,
  options: ContentStagingOptions,
  warnings: string[]
): StagedPage {
  const oldId = requireNumber(raw.id, 'pages.id')
  const sourceAuthorId = asNullableNumber(raw.authorId)
  const sourceCreatorId = asNullableNumber(raw.creatorId)
  const author = resolveActorId(sourceAuthorId, options.userIdMap, options.fallbackActorId)
  const creator = resolveActorId(sourceCreatorId, options.userIdMap, options.fallbackActorId)
  if (author.usedFallback) {
    warnings.push(
      `page ${oldId}: authorId ${sourceAuthorId} has no entry in the user id map — falling back to the operator actor.`
    )
  }
  if (creator.usedFallback) {
    warnings.push(
      `page ${oldId}: creatorId ${sourceCreatorId} has no entry in the user id map — falling back to the operator actor.`
    )
  }

  return {
    oldId,
    path: asString(raw.path),
    locale: asString(raw.localeCode),
    title: asString(raw.title),
    description: asNullableString(raw.description),
    content: raw.content === null || raw.content === undefined ? null : asString(raw.content),
    render: raw.render === null || raw.render === undefined ? null : asString(raw.render),
    toc: raw.toc ?? null,
    contentType: asString(raw.contentType),
    isPrivate: asBoolean(raw.isPrivate),
    privateNS: asNullableString(raw.privateNS),
    isPublished: asBoolean(raw.isPublished),
    publishStartDate: asNullableString(raw.publishStartDate),
    publishEndDate: asNullableString(raw.publishEndDate),
    createdAt: asString(raw.createdAt),
    updatedAt: asString(raw.updatedAt),
    extra: asRecord(raw.extra),
    editorKey: asNullableString(raw.editorKey),
    tags: resolveTags(raw.tags),
    authorId: author.actorId,
    creatorId: creator.actorId,
    history: []
  }
}

function stageHistoryEntry(
  raw: SourceRecord,
  options: ContentStagingOptions,
  warnings: string[],
  pageOldId: number
): StagedPageHistoryEntry {
  const oldId = requireNumber(raw.id, 'pageHistory.id')
  const sourceAuthorId = asNullableNumber(raw.authorId)
  const author = resolveActorId(sourceAuthorId, options.userIdMap, options.fallbackActorId)
  if (author.usedFallback) {
    warnings.push(
      `pageHistory ${oldId} (page ${pageOldId}): authorId ${sourceAuthorId} has no entry in the user id map — falling back to the operator actor.`
    )
  }

  return {
    oldId,
    action: asString(raw.action, 'updated'),
    path: asString(raw.path),
    locale: asString(raw.localeCode),
    title: asString(raw.title),
    description: asNullableString(raw.description),
    content: raw.content === null || raw.content === undefined ? null : asString(raw.content),
    contentType: asString(raw.contentType),
    isPrivate: asBoolean(raw.isPrivate),
    isPublished: asBoolean(raw.isPublished),
    publishStartDate: asNullableString(raw.publishStartDate),
    publishEndDate: asNullableString(raw.publishEndDate),
    editorKey: asNullableString(raw.editorKey),
    versionDate: asString(raw.versionDate),
    createdAt: asString(raw.createdAt),
    extra: asRecord(raw.extra),
    tags: resolveTags(raw.tags),
    authorId: author.actorId
  }
}

function compareVersionDate(a: StagedPageHistoryEntry, b: StagedPageHistoryEntry): number {
  const timeA = Date.parse(a.versionDate)
  const timeB = Date.parse(b.versionDate)
  if (Number.isNaN(timeA) || Number.isNaN(timeB)) {
    // Fall back to a stable string comparison rather than letting NaN comparisons silently no-op —
    // ISO-8601 sorts lexicographically the same as chronologically for well-formed values, and this
    // only triggers for malformed ones.
    return a.versionDate.localeCompare(b.versionDate)
  }
  return timeA - timeB
}

/**
 * The lightweight pre-pass (Task #1794): walks `connector.pages()` once, retaining only the `oldId`
 * set orphan classification needs — never `content`/`render`/`toc`. See "Streaming shape" in the
 * module doc comment for why this has to run, in full, before `extractContentStaging()` can emit even
 * its first page.
 *
 * Does not call `connector.connect()`/`disconnect()` — the caller owns the connector's lifecycle, per
 * its documented contract in `./connector.ts`.
 */
export async function buildContentStagingIndex(
  connector: SourceConnector
): Promise<ContentStagingIndex> {
  const pageOldIds = new Set<number>()

  for await (const raw of connector.pages()) {
    pageOldIds.add(requireNumber(raw.id, 'pages.id'))
  }

  return { pageOldIds }
}

/**
 * Walks a connected `SourceConnector`'s `pages()` a second time (the first being
 * `buildContentStagingIndex()`, whose result this consumes as `index`), merge-joining
 * `connector.pageHistory()` in as it goes, and yields one fully-built `StagedPage` at a time —
 * `content`/`render`/`toc` (and every history entry's own `content`) exist only for as long as the
 * caller holds onto the page it was just handed. See "Streaming shape" in the module doc comment for
 * the merge-join's ordering assumption and how a violation of it degrades. Warnings and
 * `orphanedHistory` accumulate on `context` as the walk proceeds — read them once this generator has
 * been fully drained (`orphanedHistory` is only sorted at that point).
 *
 * Does not call `connector.connect()`/`disconnect()` — the caller owns the connector's lifecycle, per
 * its documented contract in `./connector.ts`. Navigation is not part of this walk at all — call
 * `extractNavigation()` separately; it carries no per-page memory concern of its own.
 */
export async function* extractContentStaging(
  connector: SourceConnector,
  options: ContentStagingOptions,
  index: ContentStagingIndex,
  context: ContentStagingContext
): AsyncGenerator<StagedPage> {
  const historyIterator = connector.pageHistory()[Symbol.asyncIterator]()
  let historyLookahead = await historyIterator.next()

  const emitOrphan = (raw: SourceRecord, sourcePageOldId: number) => {
    const entry = stageHistoryEntry(raw, options, context.warnings, sourcePageOldId)
    context.orphanedHistory.push({ ...entry, sourcePageOldId })
    context.warnings.push(
      `pageHistory ${entry.oldId}: pageId ${sourcePageOldId} matches no matching page among the current pages — kept as orphaned history (likely a deleted page).`
    )
  }

  for await (const raw of connector.pages()) {
    const staged = stagePage(raw, options, context.warnings)

    // -> Drain every pageHistory row belonging to this page (or sorting before it) before moving on —
    //    both streams are ordered ascending by the same page id, so this is a plain merge-join.
    while (!historyLookahead.done) {
      const rawHistory = historyLookahead.value
      const sourcePageOldId = asNullableNumber(rawHistory.pageId)

      if (sourcePageOldId === null) {
        context.warnings.push(
          `pageHistory ${asString(rawHistory.id, '?')}: has no pageId at all — dropped.`
        )
        historyLookahead = await historyIterator.next()
        continue
      }

      if (sourcePageOldId < staged.oldId) {
        if (index.pageOldIds.has(sourcePageOldId)) {
          // Unreachable if the source genuinely orders pageHistory() ascending by pageId, as
          // documented (`connector.ts`) — a row for an already-emitted page would mean it didn't.
          // Warn and drop rather than mis-attach it to the wrong page or lose it silently.
          context.warnings.push(
            `pageHistory ${asString(rawHistory.id, '?')}: pageId ${sourcePageOldId} belongs to an already-emitted page — pageHistory() was not ordered ascending by pageId as expected, so this row could not be attached and was dropped.`
          )
        } else {
          emitOrphan(rawHistory, sourcePageOldId)
        }
        historyLookahead = await historyIterator.next()
        continue
      }

      if (sourcePageOldId === staged.oldId) {
        staged.history.push(
          stageHistoryEntry(rawHistory, options, context.warnings, sourcePageOldId)
        )
        historyLookahead = await historyIterator.next()
        continue
      }

      // sourcePageOldId > staged.oldId: belongs to a page not yet reached — stop draining for now.
      break
    }

    staged.history.sort(compareVersionDate)
    context.stagedPageRefs.push({ oldId: staged.oldId, path: staged.path, locale: staged.locale })
    yield staged
  }

  // -> Every page has been emitted — anything left in pageHistory() names no current page at all.
  while (!historyLookahead.done) {
    const rawHistory = historyLookahead.value
    const sourcePageOldId = asNullableNumber(rawHistory.pageId)
    if (sourcePageOldId === null) {
      context.warnings.push(
        `pageHistory ${asString(rawHistory.id, '?')}: has no pageId at all — dropped.`
      )
    } else {
      emitOrphan(rawHistory, sourcePageOldId)
    }
    historyLookahead = await historyIterator.next()
  }

  context.orphanedHistory.sort(compareVersionDate)
}

/**
 * Extracts `navigation()` rows verbatim — split out from `extractContentStaging()` because navigation
 * carries no per-page memory concern of its own (one small tree per key) and has nothing to do with
 * the page/history streaming problem this module otherwise exists to solve.
 */
export async function extractNavigation(connector: SourceConnector): Promise<StagedNavigation[]> {
  const navigation: StagedNavigation[] = []
  for await (const raw of connector.navigation()) {
    navigation.push({ key: asString(raw.key), items: raw.config ?? null })
  }
  return navigation
}
