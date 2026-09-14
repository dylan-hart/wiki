import { resolveActorId } from '../id-map.ts'
import type { UserIdMap } from '../id-map.ts'
import type { SourceRecord } from '../connector.ts'

/**
 * The one method this module needs off `models/comments.ts#create()` — a structural subset (not an
 * import of the real `Comment`/create-args types) so a test can hand this a fake without pulling in the
 * real model.
 */
export interface CommentsWriteModel {
  create(input: {
    siteId: string
    pageId: string
    authorId?: string | null
    content: string
    guestName?: string | null
    guestEmail?: string | null
    guestIp?: string | null
    createdAt?: string
    updatedAt?: string
  }): Promise<{ id: string }>
  /** The one method this module needs off `models/comments.ts#setReplyTo()` — see
   *  `resolveCommentReplies()`'s own doc comment for what calls it and why. */
  setReplyTo(id: string, replyTo: string): Promise<void>
}

export interface CommentImportDeps {
  commentsModel: CommentsWriteModel
}

export interface CommentImportOptions {
  siteId: string
  // -> `UserIdMap` (`id-map.ts`), reused here for `pageIdMap` too — despite the name, it is just the
  //    generic read-only "old numeric id -> new UUID" `.get()` contract, and this module never calls
  //    anything beyond that on either map. Deliberately narrower than the concrete
  //    `Map<number, string>` the `users`/`content` phases populate, so a caller can hand in a
  //    hand-built fallback for a `MigrationContext` that never ran the owning phase.
  pageIdMap: UserIdMap
  userIdMap: UserIdMap
}

export type CommentImportFailureReason = 'malformed-record' | 'unknown-page' | 'create-error'

export interface CommentImportFailure {
  oldId: number
  reason: CommentImportFailureReason
  message: string
}

export interface CommentImportSuccess {
  oldId: number
  commentId: string
}

/**
 * Cross-record state `importComment()` accumulates across a whole `comments` stream — the same
 * "live reference, not a snapshot" shape `page-import.ts#pageIdMap` builds for pages, but owned here
 * rather than threaded in via `CommentImportOptions`: nothing upstream can pre-populate it the way
 * `userIdMap`/`pageIdMap` are pre-populated by earlier phases, since it only exists once this
 * module's own first pass starts running.
 *
 * Reply threading is the one thing this importer cannot resolve per-record: 2.x's `replyTo` can name
 * a comment that appears *later* in the same source stream, which therefore has no destination id
 * yet at the moment the reply itself is written. `idMap`/`pending` are what let a second pass
 * (`resolveCommentReplies()`) resolve that once the whole stream is done.
 */
export interface CommentImportState {
  /** old 2.x comment id -> new destination UUID, populated as each comment is written. */
  readonly idMap: Map<number, string>
  /** Every comment whose 2.x `replyTo` named another comment (not the `0`-sentinel for top-level) —
   *  resolved in the second pass, once `idMap` is complete. */
  readonly pending: { newId: string; oldReplyTo: number }[]
}

/** Builds a fresh, empty `CommentImportState` for one `comments` stream. */
export function createCommentImportState(): CommentImportState {
  return { idMap: new Map(), pending: [] }
}

/**
 * Reads a raw source value as an ISO date string `models/comments.ts#create()`'s `createdAt`/
 * `updatedAt` override params accept, tolerating both shapes a `SourceRecord` can carry it in: a
 * real `Date` (the Postgres-direct connector's own row shape for a `timestamp` column) or an
 * already-string value. Malformed or absent input degrades to `undefined` — the column's ordinary
 * `now()` default — rather than failing the whole comment's import, the same tolerance
 * `page-import.ts#normalizeStagedDate` gives a malformed staged page date.
 */
function normalizeSourceDate(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const asIso = value instanceof Date ? value.toISOString() : String(value)
  return Number.isNaN(Date.parse(asIso)) ? undefined : asIso
}

/**
 * Reads 2.x's `replyTo` column, honoring its `0`-sentinel-for-top-level convention: `0`, `null`,
 * `undefined` and anything else that doesn't parse to a positive id all mean "no parent," matching
 * how `sourcePageId`/`sourceAuthorId` are read elsewhere in this module.
 */
function normalizeReplyTo(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) && num > 0 ? num : null
}

/** Imports one 2.x comment row into the destination `comments` table directly — no staging bundle
 * (unlike the original Feature 418 plan, written before 3.0 had a comments table at all; see the
 * design spec). A guest comment (`authorId` null, `name`/`email` populated) is written as a guest,
 * never reassigned to a system user — only a registered author's id goes through the operator
 * fallback (`resolveActorId`), the same distinction `models/comments.ts#create()`'s own
 * `authorId?: string | null` already expects.
 *
 * `resolveActorId`'s real signature (`id-map.ts`) always returns a real `actorId`, falling back to its
 * `fallbackActorId` argument whenever the source id is null/undefined OR unmapped — it never returns
 * `null` itself. For a page/content author that is the right behavior (a NOT NULL destination column
 * needs *some* real actor), but a comment's `authorId` is nullable by design, and a registered 2.x
 * commenter whose id doesn't resolve should become a guest-shaped comment (author unset), not silently
 * misattributed to the operator account — the same misattribution `createProviderFallbackUserConverter`
 * explicitly avoids elsewhere. Passing `''` as the fallback and checking `resolved.usedFallback` (rather
 * than trusting the returned `actorId`) is how this module gets "no resolution -> null" out of a helper
 * designed to always return a real id, without needing a second, comment-specific resolver.
 *
 * Per-record (not a batch loop) so `phases/assets.ts` can drive it directly from `classify`, one
 * comment per call — `state` is the one piece of cross-record bookkeeping this importer needs
 * (OpenProject #3204's reply-threading fix), threaded in explicitly rather than closed over, so a
 * caller controls its lifetime the same way it already controls `options.pageIdMap`/`userIdMap`.
 *
 * `raw.createdAt`/`raw.updatedAt` are threaded through to `create()`'s own override params, so an
 * imported comment carries the 2.x source's real post/edit date. `raw.replyTo` is deliberately
 * **never** passed to `create()` here — every comment is created top-level on this first pass, with
 * its 2.x id recorded in `state.idMap` and (when `replyTo` named a real parent) queued in
 * `state.pending` — because at the time any one comment is written, a `replyTo` naming a comment
 * later in the same stream cannot yet be resolved to a destination id. `resolveCommentReplies()` is
 * the second pass that patches every pending reply's real `replyTo` in once the stream is done.
 */
export async function importComment(
  raw: SourceRecord,
  deps: CommentImportDeps,
  options: CommentImportOptions,
  state: CommentImportState = createCommentImportState()
): Promise<
  | { result: 'success'; success: CommentImportSuccess }
  | { result: 'failure'; failure: CommentImportFailure }
> {
  // -> Guards the whole-record case (`raw` itself null/undefined) the same way `phases/assets.ts`'s
  //    own `classify` guards its identifier expression — not reachable from the real connector today
  //    (`PostgresSourceConnector#comments()` always yields a real row object), but cheap enough to
  //    make this function safe to call with an untrusted `record as SourceRecord` cast without relying
  //    on the caller having already checked.
  if (!raw || typeof raw !== 'object') {
    return {
      result: 'failure',
      failure: {
        oldId: Number.NaN,
        reason: 'malformed-record',
        message: 'received a malformed comment record (not an object) — nothing to read.'
      }
    }
  }

  const oldId = typeof raw.id === 'number' ? raw.id : Number(raw.id)
  const sourcePageId = typeof raw.pageId === 'number' ? raw.pageId : Number(raw.pageId)
  const pageId = options.pageIdMap.get(sourcePageId)
  if (!pageId) {
    return {
      result: 'failure',
      failure: {
        oldId,
        reason: 'unknown-page',
        message: `pageId ${sourcePageId} was never imported — comment dropped rather than attached to nothing.`
      }
    }
  }

  const sourceAuthorId = typeof raw.authorId === 'number' ? raw.authorId : null
  let authorId: string | null = null
  if (sourceAuthorId !== null) {
    const resolved = resolveActorId(sourceAuthorId, options.userIdMap, '')
    authorId = resolved.usedFallback ? null : resolved.actorId
  }

  const oldReplyTo = normalizeReplyTo(raw.replyTo)

  try {
    const created = await deps.commentsModel.create({
      siteId: options.siteId,
      pageId,
      authorId,
      content: typeof raw.content === 'string' ? raw.content : '',
      guestName: authorId ? null : typeof raw.name === 'string' ? raw.name : null,
      guestEmail: authorId ? null : typeof raw.email === 'string' ? raw.email : null,
      guestIp: authorId ? null : typeof raw.ip === 'string' ? raw.ip : null,
      createdAt: normalizeSourceDate(raw.createdAt),
      updatedAt: normalizeSourceDate(raw.updatedAt)
    })
    if (!Number.isNaN(oldId)) {
      state.idMap.set(oldId, created.id)
    }
    if (oldReplyTo !== null) {
      state.pending.push({ newId: created.id, oldReplyTo })
    }
    return { result: 'success', success: { oldId, commentId: created.id } }
  } catch (err: any) {
    return { result: 'failure', failure: { oldId, reason: 'create-error', message: err.message } }
  }
}

/**
 * Second pass: once every comment in the stream has been written — so `state.idMap` is as complete
 * as this run will ever make it — resolves each deferred reply's real parent id and patches it in
 * via `deps.commentsModel.setReplyTo()`. See `CommentImportState.pending`'s own doc comment for why
 * this cannot happen inline on the first pass.
 *
 * A reply naming a comment that was never imported (dropped for `unknown-page`, or itself failed to
 * `create()`) is left top-level rather than treated as a hard failure — the same "orphaned FK, not a
 * crash" treatment an unmapped `pageId`/`authorId` already gets elsewhere in this importer — and is
 * surfaced through `log`, when given, so an operator can see it happened.
 */
export async function resolveCommentReplies(
  deps: CommentImportDeps,
  state: CommentImportState,
  log?: (message: string) => void
): Promise<void> {
  for (const { newId, oldReplyTo } of state.pending) {
    const parentId = state.idMap.get(oldReplyTo)
    if (!parentId) {
      log?.(
        `comment: replyTo ${oldReplyTo} was never imported — left top-level rather than orphaned.`
      )
      continue
    }
    await deps.commentsModel.setReplyTo(newId, parentId)
  }
}
