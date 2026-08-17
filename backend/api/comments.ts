import { actorFrom, loadReadablePage, mayOnPage } from './pages.ts'
import type { FastifyInstance } from 'fastify'

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

/**
 * Comments API Routes
 *
 * List and create endpoints, scoped to a single page — the reading-a-page use case. Site-wide
 * listing for admin moderation is a separate task (#611), and update/delete another (#608).
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
}

export default routes
