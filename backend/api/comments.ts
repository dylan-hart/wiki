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

interface CommentsModel {
  /** Every comment on a page, threaded, oldest first. */
  listForPage(pageId: string): Promise<ThreadedCommentRecord[]>
  /** Store a new top-level comment or reply. `authorId` is always set — guest posting is #391's
   *  own task 609, not yet wired here. */
  create(input: {
    siteId: string
    pageId: string
    authorId: string
    replyTo: string | null
    content: string
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
}

function commentsModel(): CommentsModel {
  return (WIKI.models as unknown as { comments: CommentsModel }).comments
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
 * Comments API Routes
 *
 * List, create, update and delete, all scoped to a single page. Site-wide listing for admin
 * moderation is a separate task (#611).
 */
async function routes(app: FastifyInstance) {
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
    Body: { content: string; replyTo?: string | null }
  }>(
    '/sites/:siteId/pages/:pageId/comments',
    {
      // -> Same as the list route: `write:comments` is checked per page, below
      schema: {
        summary: 'Post a comment on a page',
        description:
          'Creates a top-level comment, or a reply when `replyTo` names an existing comment on the same page. Requires a logged in user — guest posting (a name/email supplied in the body instead of a session) is not wired yet.',
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
      if (!actor) {
        return reply.unauthorized('Posting a comment requires a logged in user.')
      }
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
        authorId: actor.id,
        replyTo,
        content: req.body.content
      })
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
      return reply.code(204).send()
    }
  )
}

export default routes
