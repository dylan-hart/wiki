import { resolveActorId } from '../id-map.ts'
import type { UserIdMap } from '../id-map.ts'
import type { SourceRecord } from '../connector.ts'

/**
 * The methods this module needs off `models/comments.ts`, declared structurally so a test can hand
 * it a fake without pulling in the real model.
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
  setReplyTo(id: string, replyTo: string): Promise<void>
}

export interface CommentImportDeps {
  commentsModel: CommentsWriteModel
}

export interface CommentImportOptions {
  siteId: string
  // -> Despite the name, `UserIdMap` is just the generic read-only "old numeric id -> new UUID"
  //    `.get()` contract, so it fits pages too. Narrower than the concrete maps the `users`/`content`
  //    phases populate, so a caller may hand in a fallback when the owning phase never ran.
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
 * Cross-record state `importComment()` accumulates across a whole `comments` stream. Owned here
 * rather than threaded in through `CommentImportOptions`, since nothing upstream can pre-populate
 * it the way earlier phases pre-populate `userIdMap`/`pageIdMap`.
 *
 * Reply threading is the one thing this importer cannot resolve per record: 2.x's `replyTo` can
 * name a comment appearing *later* in the same stream, with no destination id yet at the moment the
 * reply itself is written. `idMap`/`pending` are what let `resolveCommentReplies()` finish the job.
 */
export interface CommentImportState {
  /** old 2.x comment id -> new destination UUID, populated as each comment is written. */
  readonly idMap: Map<number, string>
  /** Every comment whose 2.x `replyTo` named a real parent, resolved once `idMap` is complete. */
  readonly pending: { newId: string; oldReplyTo: number }[]
}

export function createCommentImportState(): CommentImportState {
  return { idMap: new Map(), pending: [] }
}

/**
 * Tolerates both shapes a `SourceRecord` can carry a timestamp in: a real `Date` (the
 * Postgres-direct connector's row shape) or a string. Malformed or absent degrades to `undefined`,
 * the column's ordinary `now()` default, rather than failing the whole comment's import.
 */
function normalizeSourceDate(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const asIso = value instanceof Date ? value.toISOString() : String(value)
  return Number.isNaN(Date.parse(asIso)) ? undefined : asIso
}

/**
 * 2.x spells "top-level" as a `0` sentinel: `0`, `null`, `undefined` and anything else that does not
 * parse to a positive id all mean "no parent".
 */
function normalizeReplyTo(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) && num > 0 ? num : null
}

/** Imports one 2.x comment row straight into the destination `comments` table — no staging bundle.
 * A guest comment (`authorId` null, `name`/`email` populated) is written as a guest, never
 * reassigned to a system user.
 *
 * A registered 2.x commenter whose id does not resolve also becomes a guest-shaped comment (author
 * unset) rather than a comment misattributed to the operator account. `resolveActorId` always
 * returns a real id — right for a NOT NULL content author, wrong for a comment's nullable one — so
 * this passes `''` as its fallback and reads `resolved.usedFallback` instead of the returned
 * `actorId`, rather than growing a second comment-specific resolver.
 *
 * Per-record rather than a batch loop, so a phase can drive it one comment at a time; `state` is
 * threaded in explicitly rather than closed over, so the caller controls its lifetime.
 *
 * `raw.replyTo` is deliberately never passed to `create()`: every comment is written top-level on
 * this first pass, because a `replyTo` naming a comment later in the same stream has no destination
 * id yet. `resolveCommentReplies()` patches the queued ones in afterwards.
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
  // -> Unreachable from the real connector; kept so an untrusted `record as SourceRecord` cast is
  //    safe to pass without the caller having checked first.
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
 * Second pass, run once the whole stream has been written and `state.idMap` is therefore as
 * complete as this run will make it: resolves each deferred reply's real parent id and patches it
 * in.
 *
 * A reply naming a comment that was never imported is left top-level rather than failed, and
 * reported through `log` when one is given.
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
