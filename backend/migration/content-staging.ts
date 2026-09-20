import type { SourceConnector, SourceRecord } from './connector.ts'
import { resolveActorId, type UserIdMap } from './id-map.ts'
import { convertDrawioFences } from './mappers/drawioFence.ts'
import { convertMermaidFences } from './mappers/mermaidFence.ts'
// -> Type-only, so it is erased at load time: the mutual import with importers/navigation-import.ts
//    never becomes a runtime circular dependency.
import type { NavigationPageRef } from './importers/navigation-import.ts'
import { coerceSourceBoolean } from './source-coercion.ts'

/**
 * The read side of the 2.5.x content import: walks a connected `SourceConnector`'s `pages()`,
 * `pageHistory()` and `navigation()` generators and yields one `StagedPage` at a time, tags already
 * resolved to plain strings and `authorId`/`creatorId` already resolved to 3.0 UUIDs (falling back
 * to the operator running the import wherever the source id is missing or unmapped). Staging only —
 * no writes, no db access.
 *
 * Tag resolution relies on both connector kinds denormalizing a `[{tag, title}]` `tags` field onto
 * their rows (`docs/migration/2.5x-export-bundle-format.md`), because `SourceConnector` has no
 * separate `pageTags()`/`pageHistoryTags()` generator to join against here.
 *
 * ## Streaming shape
 *
 * Orphan classification needs every page's `oldId` before it can be answered for even one page, and
 * needs nothing else about a page — so `buildContentStagingIndex()` walks `connector.pages()` once
 * up front to build exactly that set, and `extractContentStaging()` walks it a second time,
 * building each full `StagedPage` and yielding it immediately. Nothing beyond the index and the
 * current page is ever resident together.
 *
 * `pageHistory()` is merged in via a merge-join against that second walk, relying on the
 * `ORDER BY "pageId"` ordering `connector.ts` documents — the same order `pages()` yields by `id`.
 * A row sorting out of step with it is warned about and dropped rather than mis-attached to the
 * wrong page.
 */

export type StagedTag = string

export interface StagedPageHistoryEntry {
  /** The 2.x `pageHistory.id` this row came from. */
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
  /** Copied verbatim: recomputing 2.x's `2.2.17.js` backfill self-join is unnecessary for a
   * straight migration (`2.5x-source-schema.md`). */
  versionDate: string
  createdAt: string
  extra: Record<string, unknown>
  tags: StagedTag[]
  /** Resolved 3.0 UUID — the operator fallback if the 2.x row's `authorId` was null or unmapped. */
  authorId: string
}

/** A `pageHistory` row whose `pageId` names no current page: 2.x puts no FK on that column, so
 * history is meant to outlive a deleted page. Kept apart from `StagedPage.history` because there is
 * no `StagedPage` to attach it to. */
export interface OrphanedPageHistoryEntry extends StagedPageHistoryEntry {
  sourcePageOldId: number
}

export interface StagedPage {
  /** The 2.x `pages.id` this row came from. */
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
  /** Ordered by `versionDate` ascending (oldest first). */
  history: StagedPageHistoryEntry[]
}

/** A 2.x `navigation` row, JSON tree untouched. The source table is string-keyed and `'site'` is the
 * only key written in practice, but nothing here assumes there is exactly one. */
export interface StagedNavigation {
  key: string
  /** The parsed `navigation.config` tree, verbatim — its internal shape is deliberately left
   * unverified here. */
  items: unknown
}

export interface ContentStagingIndex {
  /** Every page's `oldId`, all orphan classification needs to test membership against — and all it
   * may hold resident, since keeping every page's `content`/`render`/`toc` is what the streaming
   * walk exists to avoid. */
  pageOldIds: Set<number>
}

/**
 * The run-scoped side channel `extractContentStaging()` writes into as it streams: `for await`
 * discards an async generator's return value, so everything unknowable until the whole walk has
 * finished is collected here for the caller to read afterwards. One per run.
 */
export interface ContentStagingContext {
  /** Notes on data that could not be carried across faithfully, for the CLI to report to an
   * operator rather than acted on here. */
  warnings: string[]
  /** Complete, and sorted by `versionDate` ascending, only once the `extractContentStaging()`
   * generator given this context has been fully drained. */
  orphanedHistory: OrphanedPageHistoryEntry[]
  /** Each staged page's `{oldId, path, locale}` identity, for resolving a 2.x `'page'`-type nav
   * target back onto a staged page. Complete only once the caller has drained the generator. */
  stagedPageRefs: NavigationPageRef[]
}

export function createContentStagingContext(): ContentStagingContext {
  return { warnings: [], orphanedHistory: [], stagedPageRefs: [] }
}

export interface ContentStagingOptions {
  userIdMap: UserIdMap
  /** What `resolveActorId` falls back to for 2.x's nullable/orphaned `authorId`/`creatorId` against
   * 3.0's NOT NULL columns. Required rather than resolved here: deciding who the operator is (or
   * minting a system account for them) belongs to the calling CLI. */
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

/** Normalizes a source timestamp column to ISO. A live `PostgresSourceConnector` hands back a real
 * `Date` (node-postgres's own decoding), a bundle connector a string, and bare `String(date)` is
 * `Date.prototype.toString()`'s locale/timezone-dependent format, which a strict parser rejects
 * outright. A malformed value degrades to the fallback rather than failing the whole row. */
function asNullableTimestampString(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  return value === null || value === undefined ? null : String(value)
}

/** `asNullableTimestampString` for a non-nullable field. */
function asTimestampString(value: unknown, fallback = ''): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? fallback : value.toISOString()
  }
  return value === null || value === undefined ? fallback : String(value)
}

/** A bundle-sourced 0/1 has to coerce the same as the Postgres connector's real boolean. An
 * unrecognized value (missing column, malformed row) degrades to `false` rather than throwing. */
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

/** Flattens the `[{tag, title}]` shape both connector kinds denormalize onto their rows to plain
 * tag strings, dropping anything malformed rather than aborting a whole migration on one bad tag. */
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

/** 2.x's ```diagram and bare ```mermaid fences need 3.0's `::block-drawio`/`::block-diagram`
 * wrappers to render at all. Shared by `stagePage`/`stageHistoryEntry`: a past revision's content
 * can hold either kind just as the current one can. */
function stageContent(raw: unknown, identifier: string, warnings: string[]): string | null {
  if (raw === null || raw === undefined) return null
  const drawio = convertDrawioFences(asString(raw), identifier)
  warnings.push(...drawio.warnings)
  return convertMermaidFences(drawio.content).content
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
    content: stageContent(raw.content, `page ${oldId}`, warnings),
    render: raw.render === null || raw.render === undefined ? null : asString(raw.render),
    toc: raw.toc ?? null,
    contentType: asString(raw.contentType),
    isPrivate: asBoolean(raw.isPrivate),
    privateNS: asNullableString(raw.privateNS),
    isPublished: asBoolean(raw.isPublished),
    publishStartDate: asNullableTimestampString(raw.publishStartDate),
    publishEndDate: asNullableTimestampString(raw.publishEndDate),
    createdAt: asTimestampString(raw.createdAt),
    updatedAt: asTimestampString(raw.updatedAt),
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
    content: stageContent(raw.content, `pageHistory ${oldId} (page ${pageOldId})`, warnings),
    contentType: asString(raw.contentType),
    isPrivate: asBoolean(raw.isPrivate),
    isPublished: asBoolean(raw.isPublished),
    publishStartDate: asNullableTimestampString(raw.publishStartDate),
    publishEndDate: asNullableTimestampString(raw.publishEndDate),
    editorKey: asNullableString(raw.editorKey),
    versionDate: asTimestampString(raw.versionDate),
    createdAt: asTimestampString(raw.createdAt),
    extra: asRecord(raw.extra),
    tags: resolveTags(raw.tags),
    authorId: author.actorId
  }
}

function compareVersionDate(a: StagedPageHistoryEntry, b: StagedPageHistoryEntry): number {
  const timeA = Date.parse(a.versionDate)
  const timeB = Date.parse(b.versionDate)
  if (Number.isNaN(timeA) || Number.isNaN(timeB)) {
    // A NaN comparison would silently no-op; ISO-8601 sorts lexicographically the same as
    // chronologically, so a stable string order is the best available for a malformed value.
    return a.versionDate.localeCompare(b.versionDate)
  }
  return timeA - timeB
}

/**
 * The pre-pass: walks `connector.pages()` once, retaining only the `oldId` set orphan
 * classification needs. Must run to completion before `extractContentStaging()` can emit even its
 * first page.
 *
 * Never connects or disconnects — the caller owns the connector's lifecycle.
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
 * The second walk over `connector.pages()`, merge-joining `connector.pageHistory()` in as it goes
 * and yielding one fully-built `StagedPage` at a time — a page's heavy fields live only as long as
 * the caller holds the page it was handed. Warnings and `orphanedHistory` accumulate on `context`;
 * read them only once this generator has been fully drained.
 *
 * Never connects or disconnects — the caller owns the connector's lifecycle.
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

    // -> Both streams are ordered ascending by the same page id, so this is a plain merge-join.
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
          // Unreachable while a connector upholds `connector.ts`'s documented pageId ordering.
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
 * Split out from `extractContentStaging()`: one small tree per key carries no per-page memory
 * concern, so none of the streaming machinery applies to it.
 */
export async function extractNavigation(connector: SourceConnector): Promise<StagedNavigation[]> {
  const navigation: StagedNavigation[] = []
  for await (const raw of connector.navigation()) {
    navigation.push({ key: asString(raw.key), items: raw.config ?? null })
  }
  return navigation
}
