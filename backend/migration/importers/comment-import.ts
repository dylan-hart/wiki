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
  }): Promise<{ id: string }>
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
 * comment per call — comments have no cross-record state to accumulate beyond the already-built,
 * read-only `pageIdMap`/`userIdMap` passed in via `options`, unlike the users/groups or content engines
 * (Tasks 11-12).
 */
export async function importComment(
  raw: SourceRecord,
  deps: CommentImportDeps,
  options: CommentImportOptions
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

  try {
    const created = await deps.commentsModel.create({
      siteId: options.siteId,
      pageId,
      authorId,
      content: typeof raw.content === 'string' ? raw.content : '',
      guestName: authorId ? null : typeof raw.name === 'string' ? raw.name : null,
      guestEmail: authorId ? null : typeof raw.email === 'string' ? raw.email : null,
      guestIp: authorId ? null : typeof raw.ip === 'string' ? raw.ip : null
    })
    return { result: 'success', success: { oldId, commentId: created.id } }
  } catch (err: any) {
    return { result: 'failure', failure: { oldId, reason: 'create-error', message: err.message } }
  }
}
