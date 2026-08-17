import { actorFrom, loadReadablePage, mayOnPage } from './pages.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * The contract this route file needs from `WIKI.models.comments`.
 *
 * Feature 391 (this file) is the REST wiring for the comments subsystem; the `comments` table and
 * `models/comments.ts` itself belong to the sibling Feature #389, deliberately scoped out of this
 * one so the two are not built twice. On the branch this file lives on, that model does not exist
 * yet — `models/index.ts` has no `comments` entry, and `WIKI`'s type reflects that. This interface
 * is the shape #389's model needs to satisfy for the routes below to work; `commentsModel()` reads
 * it off `WIKI.models` through a narrow cast rather than this file implementing any part of it.
 * Once #389 lands and `models/index.ts` exports a real `comments`, this cast (and this comment)
 * should be deleted in favor of the type flowing through `WikiGlobal` normally.
 *
 * `authorName`/`authorEmail` are resolved once, here in the model layer (from the account for a
 * logged in author, from the stored guest fields otherwise), so nothing downstream has to branch on
 * which kind of author a comment has.
 */
interface CommentRecord {
  id: string
  siteId: string
  pageId: string
  authorId: string | null
  authorName: string
  authorEmail: string | null
  replyTo: string | null
  content: string
  render: string | null
  createdAt: Date
  updatedAt: Date
}

/** A {@link CommentRecord} plus its direct replies, as returned by `listForPage`. */
interface ThreadedCommentRecord extends CommentRecord {
  replies: ThreadedCommentRecord[]
}

/**
 * A {@link CommentRecord} plus just enough of its page — `path`, `title` — that a moderation row can
 * link back to the source page without a second request per row, as returned by `listForSite`.
 */
interface CommentWithPageContext extends CommentRecord {
  page: { path: string; title: string }
}

interface CommentsModel {
  /** Every comment on a page, threaded, oldest first. */
  listForPage(pageId: string): Promise<ThreadedCommentRecord[]>
  /**
   * Store a new top-level comment or reply.
   *
   * Exactly one of `authorId` or `guestName`/`guestEmail` is set, matching #389's model: an
   * authenticated post carries `authorId` and leaves the guest fields null, an anonymous one carries
   * `guestName`/`guestEmail`/`guestIp` and leaves `authorId` null. `comments.ts` enforces that split
   * before calling this — this contract just needs to accept either shape.
   */
  create(input: {
    siteId: string
    pageId: string
    authorId: string | null
    replyTo: string | null
    content: string
    guestName?: string | null
    guestEmail?: string | null
    /** The poster's IP, for abuse tracking. Only ever set for a guest post. */
    guestIp?: string | null
  }): Promise<CommentRecord>
  /**
   * A single comment by id, flat (no `replies`), or `null` when it does not exist. Not present on
   * #389's model as inspected read-only on `feature/comments-data-model` at the time this file was
   * written — task 608 (update/delete) needs an existence + ownership lookup that `listForPage`
   * doesn't cheaply give it, so it is added to the contract here. Flag for whoever integrates the two
   * branches: either add `get()` to the real model, or have the route call `listForPage` and search
   * the flattened tree instead.
   */
  get(id: string): Promise<CommentRecord | null>
  /** Update a comment's content. Matches #389's `Comments.update` signature. */
  update(id: string, input: { content: string }): Promise<CommentRecord>
  /** Delete a comment (and, per #389's doc comment, its replies via cascade). */
  delete(id: string): Promise<void>
  /**
   * Every comment across a whole site, flat (never threaded — a moderation queue reads rows, not
   * threads, and rows can span unrelated pages) and joined with just enough of each comment's page
   * that a moderation UI can link back to it without a second request per row. Newest first.
   *
   * Not present on #389's model as inspected read-only on `feature/comments-data-model` at the time
   * this file was written — only `listForPage`/`countForPage` exist there, both scoped to one page.
   * Task 611 needs a genuinely different query (site-wide, filtered, paginated, joined with `pages`
   * for `path`/`title`) that neither of those can serve, so it is added to the contract here, same
   * as `get()` above. Flag for whoever integrates the two branches.
   */
  listForSite(input: {
    siteId: string
    /** Only comments on pages whose path starts with this. */
    path?: string
    /** Matched against `authorName` (which is itself `guestName` for a guest comment), case-insensitively. */
    authorName?: string
    createdAfter?: Date
    createdBefore?: Date
    offset: number
    limit: number
  }): Promise<{ comments: CommentWithPageContext[]; totalHits: number }>
}

function commentsModel(): CommentsModel {
  return (WIKI.models as unknown as { comments: CommentsModel }).comments
}

/**
 * Queue `comment:new` / `comment:edit` / `comment:delete` webhook deliveries (task 610).
 *
 * The convention elsewhere (`models/pages.ts`'s `page:create` et al., `models/assets.ts`'s
 * `asset:upload` et al.) is to call `WIKI.models.hooks.emit()` from inside the model's write
 * methods, so every caller of the model gets the event, not just one REST route. That is exactly
 * where this belongs too — but `models/comments.ts` is Feature #389's file (see the `CommentRecord`
 * contract comment above) and does not exist on this branch, so there is nowhere in a model to put
 * it. This route is presently the only way anything on this branch writes a comment, so calling it
 * here is functionally equivalent for now. FLAG FOR INTEGRATION: once #389 lands and a real
 * `models/comments.ts` exists, move these three `emit()` calls into its `create`/`update`/`delete`
 * methods and delete this helper, matching the page/asset convention exactly.
 *
 * Payload mirrors the page/asset shape (`id`, `siteId`, `authorId`, `metadata`/`content`), plus
 * `pageId` (comments are always scoped to a page) and `isGuest` — the `author.isGuest` convention
 * already used by `models/approvals.ts`'s `ReviewableSubmission`, so a null `authorId` reads as "no
 * account", not as a missing field. `content` is the comment body, split out from `metadata` the same
 * way `hooks.emit()` splits every event's payload: a hook only receives it when its own
 * `includeContent` is on.
 */
async function emitCommentEvent(
  event: 'comment:new' | 'comment:edit' | 'comment:delete',
  comment: CommentRecord
): Promise<void> {
  const base = {
    id: comment.id,
    pageId: comment.pageId,
    siteId: comment.siteId,
    authorId: comment.authorId,
    isGuest: comment.authorId === null
  }
  await WIKI.models.hooks.emit(
    event,
    event === 'comment:delete'
      ? base
      : {
          ...base,
          metadata: { authorName: comment.authorName, replyTo: comment.replyTo },
          content: comment.content
        }
  )
}

/**
 * A comment as this route hands it back, with `authorEmail` masked unless the caller asked to keep
 * it.
 *
 * The page-view list is read by anonymous visitors as often as logged in ones — `read:comments` is
 * explicitly anonymous-safe — so publishing every commenter's address to whoever loads the page would
 * leak it well past the account settings page it otherwise lives behind. The response to posting a
 * comment is the one case that is fine to keep it on: that reader is the comment's own author, being
 * shown their own address back.
 */
function toPublicComment(
  comment: ThreadedCommentRecord | CommentRecord,
  { includeEmail }: { includeEmail: boolean }
): Record<string, unknown> {
  const replies = 'replies' in comment ? comment.replies : []
  return {
    id: comment.id,
    siteId: comment.siteId,
    pageId: comment.pageId,
    authorId: comment.authorId,
    authorName: comment.authorName,
    authorEmail: includeEmail ? comment.authorEmail : null,
    replyTo: comment.replyTo,
    content: comment.content,
    render: comment.render,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    replies: replies.map((reply) => toPublicComment(reply, { includeEmail }))
  }
}

/**
 * A comment as the site-wide moderation list hands it back: flat (no `replies` — a moderation queue
 * reads rows across unrelated pages, not one page's thread), with `authorEmail` left unmasked (see
 * the doc comment on the route below for why that's safe here but not on `toPublicComment`), plus
 * `page` for the row's linkback.
 */
function toModerationComment(comment: CommentWithPageContext): Record<string, unknown> {
  return {
    id: comment.id,
    siteId: comment.siteId,
    pageId: comment.pageId,
    authorId: comment.authorId,
    authorName: comment.authorName,
    authorEmail: comment.authorEmail,
    replyTo: comment.replyTo,
    content: comment.content,
    render: comment.render,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    page: comment.page
  }
}

/** Every id in a threaded list, replies included — for validating a `replyTo` against. */
function flattenIds(thread: ThreadedCommentRecord[]): Set<string> {
  const ids = new Set<string>()
  const visit = (nodes: ThreadedCommentRecord[]) => {
    for (const node of nodes) {
      ids.add(node.id)
      visit(node.replies)
    }
  }
  visit(thread)
  return ids
}

const siteIdParam = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId']
}

const pageIdParam = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    pageId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId', 'pageId']
}

const commentIdParam = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    pageId: { type: 'string', format: 'uuid' },
    commentId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId', 'pageId', 'commentId']
}

/**
 * Whether this requester may edit or delete `comment`.
 *
 * SELF-AUTHORSHIP POLICY (task 608): 2.5.x's `server/models/comments.js` requires `manage:comments`
 * for every edit and delete, with no exception for the comment's own author — confirmed by reading
 * that file directly. This fork deliberately diverges: a comment's own author
 * (`comment.authorId === actor.id`) may edit or delete it without holding `manage:comments`. Fixing
 * a typo or retracting your own remark is the overwhelmingly common case, and forcing every one of
 * those through a moderator permission that most contributors will never hold is unfriendly friction
 * upstream never actually needed the safety of — moderation is still fully enforced for everyone
 * else's comments, which is the case that matters.
 *
 * `manage:comments` always overrides, regardless of authorship, in both directions: a moderator may
 * act on their own comment or anyone else's. Moderation has to work even when the authorship check
 * would otherwise say no, so it is checked first and short-circuits the rest.
 *
 * GUESTS (authorId null): a guest-authored comment can never be self-edited, under either policy.
 * There is no account behind it to match `actor.id` against — `authorId === actor.id` is false for
 * every actor when `authorId` is null, including, deliberately, the guest who originally posted it:
 * nothing on a later, unauthenticated request can prove they are the same person, so the only way to
 * touch a guest comment is `manage:comments`.
 */
function maySelfModerate(
  req: FastifyRequest,
  page: { path: string; locale?: string; tags?: string[] },
  comment: CommentRecord,
  actor: { id: string } | null
): boolean {
  if (mayOnPage(req, 'manage:comments', page)) {
    return true
  }
  return Boolean(actor && comment.authorId !== null && comment.authorId === actor.id)
}

/**
 * Whether this requester holds `manage:comments` ANYWHERE — i.e. some rule, pooled across their
 * groups, grants it for some path — rather than on one specific page.
 *
 * The site-wide moderation listing (task 611) has no single page to evaluate `mayOnPage` against:
 * that is the whole point of it, a view that spans every page on the site. `pagePermissionsFor` in
 * `api/pages.ts` answers the adjacent question ("every permission held AT THIS page") by pooling the
 * actor's groups and asking `checkAccess` per permission against one `page`; this asks the same
 * underlying page-rule layer the identical question with the page dropped — does ANY rule anywhere
 * in the pool grant this permission, on whatever path it names — rather than inventing a new access
 * check. `manage:system` bypasses everything first, exactly as `checkAccess` does.
 *
 * A DENY rule elsewhere that narrows or fully overrides a broader ALLOW for a specific path is not
 * accounted for here — that only matters once a concrete page is in play, which is `mayOnPage`'s job,
 * not this one's. This answers "holds it somewhere", the same coarse question `pagePermissionsFor`
 * answers per path; a wiki that wants `manage:comments` to gate this route more precisely can attach
 * it to a group's global permission list instead of a page rule.
 */
function mayManageCommentsAnywhere(req: FastifyRequest): boolean {
  const actor = WIKI.models.groups.actorForRequest(req)
  if (actor.permissions.includes('manage:system')) {
    return true
  }
  return WIKI.models.groups
    .rulesForGroups(actor.groupIds)
    .some((rule) => rule.roles.includes('manage:comments') && rule.mode !== 'DENY')
}

/**
 * Comments API Routes
 *
 * List, create, update and delete, all scoped to a single page, plus a site-wide list for admin
 * moderation (task 611).
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST COMMENTS SITE-WIDE (moderation)
   */
  app.get<{
    Params: { siteId: string }
    Querystring: {
      path?: string
      author?: string
      createdAfter?: string
      createdBefore?: string
      offset?: number
      limit?: number
    }
  }>(
    '/sites/:siteId/comments',
    {
      /*
        No route-level `permissions`: `manage:comments` is a page-rule permission, granted by a
        group's rules per path, not the group-wide list that hook checks. This route has no single
        page to check it against — that's the whole point of a site-wide listing — so it asks a
        different question than `mayOnPage` can: does this actor hold `manage:comments` on AT LEAST
        ONE path, via `mayManageCommentsAnywhere` below. See that function's doc comment for how it
        reuses the same page-rule pooling `pagePermissionsFor` (`api/pages.ts`) uses, rather than
        inventing a new access check.
      */
      schema: {
        summary: 'List comments across a site, for moderation',
        description:
          'Every comment on the site, flat and newest first, for an admin moderation queue rather ' +
          "than a single page's thread — the per-page endpoint above serves that use case; this one " +
          "serves #394's site-wide moderation UI. Requires `manage:comments` on at least one path " +
          '(see `mayManageCommentsAnywhere`); a caller who only holds it on some paths still sees ' +
          'every comment on the site, not only those under the paths they moderate — narrowing this ' +
          "further is left to a future task, since nothing in #611's spec asked for it.\n\n" +
          "`authorEmail` is included, unmasked, unlike the per-page list's: reaching this endpoint at " +
          'all already requires `manage:comments`, so there is no anonymous-reader audience to guard ' +
          'it from — the same address a moderator could look up per comment via the page-view ' +
          "endpoint's own POST-response echo, just without the extra round trip.\n\n" +
          'Each row carries `page.path`/`page.title` so a moderation UI can link back to the source ' +
          'page without a second request per row.',
        tags: ['Comments'],
        params: siteIdParam,
        querystring: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              maxLength: 2048,
              description: 'Only comments on pages whose path starts with this.'
            },
            author: {
              type: 'string',
              maxLength: 255,
              description:
                "Matched against the comment author's display name, case-insensitively. Matches a " +
                "guest's name too, since `authorName` resolves to `guestName` for a guest comment."
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Only comments created at or after this instant.'
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'Only comments created at or before this instant.'
            },
            offset: {
              type: 'integer',
              minimum: 0,
              default: 0
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 25
            }
          }
        },
        response: {
          200: {
            description: 'Matching comments, plus how many there are in total',
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: { $ref: 'CommentModerationItem#' }
              },
              totalHits: {
                type: 'integer',
                description: 'How many comments match, ignoring `limit` and `offset`.'
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      if (!mayManageCommentsAnywhere(req)) {
        return reply.forbidden('You are not allowed to moderate comments on this site.')
      }

      const offset = req.query.offset ?? 0
      const limit = req.query.limit ?? 25
      const { comments, totalHits } = await commentsModel().listForSite({
        siteId: req.params.siteId,
        path: req.query.path,
        authorName: req.query.author,
        createdAfter: req.query.createdAfter ? new Date(req.query.createdAfter) : undefined,
        createdBefore: req.query.createdBefore ? new Date(req.query.createdBefore) : undefined,
        offset,
        limit
      })
      return {
        results: comments.map((comment) => toModerationComment(comment)),
        totalHits
      }
    }
  )

  /**
   * LIST COMMENTS FOR A PAGE
   */
  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/comments',
    {
      /*
        No route-level `permissions`: `read:comments` is a page-rule permission, granted by a
        group's rules and not the group-wide list that hook checks — decided per page below, exactly
        as `watching.ts` does for `read:pages`. Anonymous-safe: the Guests group can hold
        `read:comments`, same as it can hold `read:pages`.
      */
      schema: {
        summary: 'List the comments on a page',
        description:
          "The full threaded comment list for a page, oldest first at every level. `authorEmail` is always null here — this endpoint is read by anonymous visitors as often as logged in ones, so a commenter's address is never published through it.",
        tags: ['Comments'],
        params: pageIdParam,
        response: {
          200: {
            description: 'Comments on this page, threaded',
            type: 'array',
            items: { $ref: 'Comment#' }
          }
        }
      }
    },
    async (req, reply) => {
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'read:comments', page)) {
        return reply.forbidden('You are not allowed to read comments on this page.')
      }
      if (page.isLocked) {
        return reply.forbidden('This page is password protected.')
      }
      const thread = await commentsModel().listForPage(page.id)
      return thread.map((comment) => toPublicComment(comment, { includeEmail: false }))
    }
  )

  /**
   * POST A COMMENT
   */
  app.post<{
    Params: { siteId: string; pageId: string }
    Body: {
      content: string
      replyTo?: string | null
      guestName?: string | null
      guestEmail?: string | null
    }
  }>(
    '/sites/:siteId/pages/:pageId/comments',
    {
      /*
        No route-level `permissions`: same as the list route, `write:comments` is a page-rule
        permission decided per page below — and, per task 609, THIS route is the anonymous-safe one
        of the two, mirroring 2.5.x's guest commenting. An anonymous actor reaches `mayOnPage` the
        same way an authenticated one does (`WIKI.models.groups.actorForRequest` resolves it to the
        Guests group), so a wiki that grants that group `write:comments` gets guest posting simply by
        the rule existing — nothing here special-cases "no session" as a blanket refusal.
      */
      schema: {
        summary: 'Post a comment on a page',
        description:
          'Creates a top-level comment, or a reply when `replyTo` names an existing comment on the ' +
          'same page.\n\n' +
          '**Authenticated** (a session is present): identity comes from the session only. ' +
          '`guestName`/`guestEmail` in the body are rejected with 400 rather than silently ignored — ' +
          "an authenticated comment cannot claim a different name than the poster's account.\n\n" +
          '**Anonymous** (no session): allowed only when the Guests group (or another rule matching ' +
          'this requester) grants `write:comments` on this page. `guestName` and `guestEmail` are then ' +
          'required in the body — there is no account to draw a name/address from — and the poster’s ' +
          'IP is recorded for abuse tracking. `guestEmail` is validated as an email at the schema level.',
        tags: ['Comments'],
        params: pageIdParam,
        body: { $ref: 'CommentInput#' },
        response: {
          200: {
            description: 'The comment as stored',
            $ref: 'Comment#'
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'write:comments', page)) {
        return reply.forbidden('You are not allowed to comment on this page.')
      }
      if (page.isLocked) {
        return reply.forbidden('This page is password protected.')
      }

      // -> The guest-vs-authenticated split (task 609): an authenticated poster's identity comes
      //    from the session only, so guest fields on the body are rejected outright rather than
      //    silently dropped — a caller sending them almost certainly expected them to take effect. An
      //    anonymous poster has no session to draw an identity from, so the same fields are required
      //    instead.
      if (actor) {
        if (req.body.guestName != null || req.body.guestEmail != null) {
          return reply.badRequest(
            'guestName/guestEmail may not be set on an authenticated request; your account identity is used instead.'
          )
        }
      } else if (!req.body.guestName || !req.body.guestEmail) {
        return reply.badRequest(
          'guestName and guestEmail are required to comment without an account.'
        )
      }

      const replyTo = req.body.replyTo ?? null
      if (replyTo) {
        // -> A `replyTo` naming a comment that doesn't exist, or that exists on a different page,
        //    must be rejected rather than stored: `listForPage` is scoped to THIS page, so a
        //    cross-page id simply won't be found here either way.
        const thread = await commentsModel().listForPage(page.id)
        if (!flattenIds(thread).has(replyTo)) {
          return reply.badRequest('replyTo does not name a comment on this page.')
        }
      }

      const comment = await commentsModel().create({
        siteId: req.params.siteId,
        pageId: page.id,
        authorId: actor ? actor.id : null,
        replyTo,
        content: req.body.content,
        // -> Guest fields only ever travel together: an authenticated post has none of them, an
        //    anonymous one has all three (the validation above guarantees guestName/guestEmail are
        //    present by this point). `req.ip` is Fastify's resolved client address (honors
        //    `trustProxy`, same as the rest of this codebase), captured here for abuse tracking —
        //    Akismet/rate-limit policy itself is #390's job, not this route's.
        guestName: actor ? null : req.body.guestName,
        guestEmail: actor ? null : req.body.guestEmail,
        guestIp: actor ? null : req.ip
      })
      await emitCommentEvent('comment:new', comment)
      return toPublicComment(comment, { includeEmail: true })
    }
  )

  /**
   * UPDATE A COMMENT
   */
  app.patch<{
    Params: { siteId: string; pageId: string; commentId: string }
    Body: { content: string }
  }>(
    '/sites/:siteId/pages/:pageId/comments/:commentId',
    {
      // -> Same as the list route: `read:comments` is checked per page, below. The author/moderator
      //    decision past that point is `maySelfModerate`'s policy, not a route-level permission.
      schema: {
        summary: 'Edit a comment',
        description:
          "Updates a comment's content. Allowed for the comment's own author, or for anyone holding " +
          '`manage:comments` on this page. A guest-authored comment (no account behind it) can only ' +
          'be edited via `manage:comments`.',
        tags: ['Comments'],
        params: commentIdParam,
        body: { $ref: 'CommentInput#' },
        response: {
          200: {
            description: 'The comment as stored, updated',
            $ref: 'Comment#'
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'read:comments', page)) {
        return reply.forbidden('You are not allowed to read comments on this page.')
      }
      if (page.isLocked) {
        return reply.forbidden('This page is password protected.')
      }

      // -> Existence is checked only after the page-level read gate above, so a comment's presence
      //    is never revealed to a requester who could not even see the page's comments at all.
      const comment = await commentsModel().get(req.params.commentId)
      if (!comment || comment.pageId !== page.id) {
        return reply.notFound('This comment does not exist.')
      }

      if (!maySelfModerate(req, page, comment, actor)) {
        return reply.forbidden('You are not allowed to edit this comment.')
      }

      const updated = await commentsModel().update(comment.id, { content: req.body.content })
      await emitCommentEvent('comment:edit', updated)
      return toPublicComment(updated, { includeEmail: false })
    }
  )

  /**
   * DELETE A COMMENT
   */
  app.delete<{
    Params: { siteId: string; pageId: string; commentId: string }
  }>(
    '/sites/:siteId/pages/:pageId/comments/:commentId',
    {
      // -> Same as PATCH: `read:comments` per page below, then `maySelfModerate`'s policy.
      schema: {
        summary: 'Delete a comment',
        description:
          "Deletes a comment. Allowed for the comment's own author, or for anyone holding " +
          '`manage:comments` on this page. A guest-authored comment (no account behind it) can only ' +
          'be deleted via `manage:comments`.',
        tags: ['Comments'],
        params: commentIdParam,
        response: {
          204: {
            description: 'The comment was deleted',
            type: 'null'
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      const page = await loadReadablePage(req, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'read:comments', page)) {
        return reply.forbidden('You are not allowed to read comments on this page.')
      }
      if (page.isLocked) {
        return reply.forbidden('This page is password protected.')
      }

      // -> Same ordering as PATCH: existence is only checked past the page-level read gate.
      const comment = await commentsModel().get(req.params.commentId)
      if (!comment || comment.pageId !== page.id) {
        return reply.notFound('This comment does not exist.')
      }

      if (!maySelfModerate(req, page, comment, actor)) {
        return reply.forbidden('You are not allowed to delete this comment.')
      }

      await commentsModel().delete(comment.id)
      await emitCommentEvent('comment:delete', comment)
      return reply.code(204).send()
    }
  )
}

export default routes
