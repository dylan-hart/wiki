import type { SourceConnector, SourceRecord } from './connector.ts'
import { IdMap, resolveActorId, type UserIdMap } from './id-map.ts'

/**
 * Content staging & id-mapping scaffold (Feature 416 / Task 733)
 *
 * The read side this feature owns: walks a connected `SourceConnector`'s `pages()`, `pageHistory()`
 * and `navigation()` generators and produces one in-process structure joining a page to its
 * locale-variant siblings and its full history chain, with tags already resolved to plain strings and
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
 * `extractContentStaging` streams rather than buffers (task 1798, from the 2026-08-24 audit's
 * migration-correctness findings): `StagedPage` carries `content`/`render`/`toc`, and each history
 * entry carries its own `content` — resident for every page and every revision of a large source
 * wiki is exactly the "buffer an entire table in memory" `connector.ts`'s own doc comment says a
 * `SourceConnector` generator exists to avoid. The algorithm walks `connector.pages()` **twice**:
 *
 * 1. A lightweight pre-pass builds `pathToOldIds` (a `path → oldId[]` bucket map, feeding
 *    `localeSiblingOldIds`) and `pageOldIds` (a `Set<number>`, feeding orphan classification below) —
 *    reading only `raw.id`/`raw.path` off each row, never `content`/`render`/`toc`.
 * 2. The real staging pass re-walks `connector.pages()` and merges it against `connector.pageHistory()`
 *    (grouped into contiguous per-`pageId` runs by `groupHistoryByPage`) as it goes, yielding one fully
 *    staged `StagedPage` — history attached — per page. Only the current page and the current history
 *    group are ever resident; nothing accumulates across the walk.
 *
 * The merge in step 2 relies on both `pages()` and `pageHistory()` being produced in ascending-by-
 * old-id order — true of `PostgresSourceConnector` (`ORDER BY p.id` / `ORDER BY ph."pageId"`, see
 * `connectors/postgres.ts`) and the assumption `docs/migration/2.5x-export-bundle-format.md:277`'s
 * "mirror the exporter's batch sizes" note and this task's own name ("history merged from the
 * already-`ORDER BY \"pageId\"`-sorted `pageHistory()` stream") both take for granted. `pageOldIds`
 * (from the pre-pass, independent of either stream's order) is what actually *classifies* a drained
 * history group as a genuine orphan rather than the ordering assumption itself — see
 * `groupHistoryByPage`'s call site in `streamStagedPages` for how a same-id-but-out-of-position group
 * is told apart from a truly orphaned one.
 */

/** A 2.x tag string, resolved (from `pageTags`/`pageHistoryTags` via `tags.tag`) rather than left as
 * a bare `tagId` — see the module doc comment above for where the resolution actually happens. */
export type StagedTag = string

export interface StagedPageHistoryEntry {
  /** The 2.x `pageHistory.id` this row came from — what a page-history id map (built the same way as
   * `pageIdMap` below, by whichever task actually inserts these rows) keys off. */
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
  /** The 2.x `authorId` this was resolved from, `null` if the source column itself was null. Kept for
   * traceability/reporting, not consumed by any write path. */
  sourceAuthorId: number | null
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
  /** The 2.x `pages.id` this row came from — what `pageIdMap` (see `ContentStagingResult`) is keyed
   * on once a later task calls `createPage()` for it. */
  oldId: number
  path: string
  locale: string
  title: string
  hash: string
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
  /** The 2.x `authorId`/`creatorId` these were resolved from, `null` if the source column itself was
   * null. Kept for traceability/reporting, not consumed by any write path. */
  sourceAuthorId: number | null
  sourceCreatorId: number | null
  /** Old ids of every other 2.x page sharing this page's `path` under a different `localeCode` — the
   * "joined to its localeCode variant siblings" join this task's description calls for. Does not
   * include this page's own `oldId`. */
  localeSiblingOldIds: number[]
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

export interface ContentStagingResult {
  /** One `StagedPage` at a time, each already carrying its full `history` chain — see the module doc
   * comment for why this is a lazy generator rather than an array. Nothing upstream of this generator
   * (the pre-pass, the page/history merge below) retains a page's `content`/`render`/`toc` or a
   * history entry's `content` once that page has been yielded; the caller decides how long to hold
   * the page it just received. Draining `pages` to completion is what finishes populating
   * `orphanedHistory` and `warnings` below — read those only after the walk. */
  pages: AsyncGenerator<StagedPage>
  /** `pageHistory` rows whose `pageId` matched no row in `pages` — see `OrphanedPageHistoryEntry`.
   * Populated as `pages` is drained; complete only once the walk has finished. */
  orphanedHistory: OrphanedPageHistoryEntry[]
  navigation: StagedNavigation[]
  /** The old-pageId → new-UUID map this feature depends on, per this task's description — starts
   * empty. Task 738 populates it with `pageIdMap.set(staged.oldId, createdPage.id)` as it creates each
   * page; Task 740 (history backfill) then resolves `pageHistory.pageId` through the same instance. */
  pageIdMap: IdMap<number>
  /** Human-readable notes on data that could not be carried across faithfully — currently: an
   * orphaned `authorId`/`creatorId` FK (present in the source, unmapped by `userIdMap`) that fell back
   * to the operator actor, and a `pageHistory` row that named no current page. Surfaced for whichever
   * task ends up reporting import results to an operator (Task 421's CLI) rather than acted on here.
   * Populated as `pages` is drained; complete only once the walk has finished. */
  warnings: string[]
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

function asBoolean(value: unknown): boolean {
  return value === true
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
    hash: asString(raw.hash),
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
    sourceAuthorId,
    sourceCreatorId,
    localeSiblingOldIds: [],
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
    authorId: author.actorId,
    sourceAuthorId
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

/** One contiguous run of `pageHistory()` rows sharing a `pageId`, already sorted by `versionDate`
 * ascending — what `groupHistoryByPage` yields, and what the merge in `streamStagedPages` attaches to
 * (or orphans away from) a single page. */
interface HistoryGroup {
  pageOldId: number
  entries: StagedPageHistoryEntry[]
}

/**
 * Groups a `pageHistory()` stream into one `HistoryGroup` per contiguous run of matching `pageId` —
 * bounding resident memory to a single page's revision chain rather than the whole table, which is
 * what makes the merge in `streamStagedPages` safe to run against an unbounded `pageHistory()` walk.
 * Relies on same-`pageId` rows being contiguous in the underlying stream (see the module doc comment
 * for which connector actually guarantees this via `ORDER BY "pageId"`) — a `pageId` that reappears
 * non-contiguously would surface as a second, later group rather than being merged into the first.
 */
async function* groupHistoryByPage(
  history: AsyncIterable<SourceRecord>,
  options: ContentStagingOptions,
  warnings: string[]
): AsyncGenerator<HistoryGroup> {
  let currentPageOldId: number | null = null
  let currentEntries: StagedPageHistoryEntry[] = []

  for await (const raw of history) {
    const sourcePageOldId = asNullableNumber(raw.pageId)
    if (sourcePageOldId === null) {
      warnings.push(`pageHistory ${asString(raw.id, '?')}: has no pageId at all — dropped.`)
      continue
    }
    if (currentPageOldId !== null && sourcePageOldId !== currentPageOldId) {
      currentEntries.sort(compareVersionDate)
      yield { pageOldId: currentPageOldId, entries: currentEntries }
      currentEntries = []
    }
    currentPageOldId = sourcePageOldId
    currentEntries.push(stageHistoryEntry(raw, options, warnings, sourcePageOldId))
  }
  if (currentPageOldId !== null) {
    currentEntries.sort(compareVersionDate)
    yield { pageOldId: currentPageOldId, entries: currentEntries }
  }
}

/** Minimal one-item-lookahead wrapper over an async generator — lets `streamStagedPages` decide,
 * without consuming, whether the next history group belongs to the page currently being staged, an
 * earlier orphan, or a later page. */
class Peekable<T> {
  private readonly source: AsyncGenerator<T>
  private buffered: { value: T } | null = null
  private exhausted = false

  constructor(source: AsyncGenerator<T>) {
    this.source = source
  }

  async peek(): Promise<T | undefined> {
    if (!this.buffered && !this.exhausted) {
      const result = await this.source.next()
      if (result.done) {
        this.exhausted = true
      } else {
        this.buffered = { value: result.value }
      }
    }
    return this.buffered?.value
  }

  async take(): Promise<T | undefined> {
    const value = await this.peek()
    this.buffered = null
    return value
  }
}

/**
 * The real streaming pass: re-walks `connector.pages()`, merging in history groups from
 * `connector.pageHistory()` as it goes, and yields one fully staged `StagedPage` at a time. Mutates
 * `warnings`/`orphanedHistory` (owned by `extractContentStaging`) as it drains rather than returning
 * them, since an async generator can only hand back one stream of values.
 */
async function* streamStagedPages(
  connector: SourceConnector,
  options: ContentStagingOptions,
  warnings: string[],
  orphanedHistory: OrphanedPageHistoryEntry[],
  pathToOldIds: Map<string, number[]>,
  pageOldIds: Set<number>
): AsyncGenerator<StagedPage> {
  const historyGroups = new Peekable(groupHistoryByPage(connector.pageHistory(), options, warnings))

  const pushOrphan = (group: HistoryGroup): void => {
    // A group whose pageId genuinely names no page in the corpus (checked against the pre-pass'
    // Set, not stream position) is a real orphan — the common case, a deleted 2.x page. A group whose
    // pageId DOES name a real page but was drained here anyway means the pages()/pageHistory()
    // ordering assumption above didn't hold for this row; still nowhere to attach it (the page it
    // belongs to has already been yielded, or hasn't been reached the way this merge expects), so it
    // is orphaned too, but with a distinct message rather than a misleading "no matching page".
    const trulyOrphaned = !pageOldIds.has(group.pageOldId)
    for (const entry of group.entries) {
      orphanedHistory.push({ ...entry, sourcePageOldId: group.pageOldId })
      warnings.push(
        trulyOrphaned
          ? `pageHistory ${entry.oldId}: pageId ${group.pageOldId} matches no matching page among the current pages — kept as orphaned history (likely a deleted page).`
          : `pageHistory ${entry.oldId}: pageId ${group.pageOldId} names a page that exists but was not reachable at its position in the "pageId"-ordered walk — kept as orphaned history rather than mis-attached.`
      )
    }
  }

  for await (const raw of connector.pages()) {
    const staged = stagePage(raw, options, warnings)
    const siblings = pathToOldIds.get(staged.path)
    if (siblings) {
      staged.localeSiblingOldIds = siblings.filter((id) => id !== staged.oldId)
    }

    // Drain every history group that sorts strictly before this page — under the ordering assumption
    // above, none of them can belong to a page still to come.
    let nextGroup = await historyGroups.peek()
    while (nextGroup && nextGroup.pageOldId < staged.oldId) {
      pushOrphan((await historyGroups.take()) as HistoryGroup)
      nextGroup = await historyGroups.peek()
    }

    if (nextGroup && nextGroup.pageOldId === staged.oldId) {
      staged.history = ((await historyGroups.take()) as HistoryGroup).entries
    }

    yield staged
  }

  // Anything left named a pageId no page in the walk above ever matched (either because it truly
  // names no page, or because it sorted after the very last one).
  let remaining = await historyGroups.take()
  while (remaining) {
    pushOrphan(remaining)
    remaining = await historyGroups.take()
  }

  orphanedHistory.sort(compareVersionDate)
}

/**
 * Walks a connected `SourceConnector`'s `pages()`, `pageHistory()` and `navigation()` generators and
 * produces the joined, id-resolved staging structure this feature's later tasks (736/738/740/741)
 * consume. Does not call `connector.connect()`/`disconnect()` — the caller owns the connector's
 * lifecycle, per its documented contract in `./connector.ts`. See the module doc comment for why
 * `result.pages` is a lazy generator rather than an array.
 */
export async function extractContentStaging(
  connector: SourceConnector,
  options: ContentStagingOptions
): Promise<ContentStagingResult> {
  const warnings: string[] = []
  const orphanedHistory: OrphanedPageHistoryEntry[] = []

  // Lightweight pre-pass: only `id`/`path` are read off each row, never content/render/toc.
  const pathToOldIds = new Map<string, number[]>()
  const pageOldIds = new Set<number>()
  for await (const raw of connector.pages()) {
    const oldId = requireNumber(raw.id, 'pages.id')
    const pagePath = asString(raw.path)
    pageOldIds.add(oldId)
    const bucket = pathToOldIds.get(pagePath)
    if (bucket) {
      bucket.push(oldId)
    } else {
      pathToOldIds.set(pagePath, [oldId])
    }
  }

  const navigation: StagedNavigation[] = []
  for await (const raw of connector.navigation()) {
    navigation.push({ key: asString(raw.key), items: raw.config ?? null })
  }

  return {
    pages: streamStagedPages(
      connector,
      options,
      warnings,
      orphanedHistory,
      pathToOldIds,
      pageOldIds
    ),
    orphanedHistory,
    navigation,
    pageIdMap: new IdMap<number>(),
    warnings
  }
}
