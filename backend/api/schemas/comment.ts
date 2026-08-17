import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * COMMENT INPUT - The writable fields when posting a comment
   *
   * Guest fields (name/email for an unauthenticated poster) are not part of this yet — that is
   * Feature 391's guest-posting task. Until then, posting a comment requires a logged in user, whose
   * identity comes from the session rather than the body.
   */
  app.addSchema({
    $id: 'CommentInput',
    type: 'object',
    properties: {
      content: {
        type: 'string',
        minLength: 1,
        description: 'The comment source, in whatever format the comments provider renders.'
      },
      replyTo: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description:
          'The comment being replied to, on the same page. Omit or null for a top-level comment.'
      }
    },
    required: ['content']
  })

  /**
   * COMMENT - A single comment, with its direct replies nested under it
   *
   * `authorId` is null for a guest comment; `authorName`/`authorEmail` are resolved from the account
   * for a logged in author and from the stored guest fields otherwise, so a caller reading a comment
   * never needs to branch on which kind it is. `authorEmail` is deliberately left unset (rather than
   * populated) by the page-view list endpoint — every reader of that endpoint may be anonymous, and
   * an author's address is not published to the page just because their comment is. It IS populated
   * on the response to posting a comment, since that is the poster being shown their own address back.
   */
  app.addSchema({
    $id: 'Comment',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      siteId: {
        type: 'string',
        format: 'uuid'
      },
      pageId: {
        type: 'string',
        format: 'uuid'
      },
      authorId: {
        type: 'string',
        format: 'uuid',
        nullable: true
      },
      authorName: {
        type: 'string'
      },
      authorEmail: {
        type: 'string',
        nullable: true
      },
      replyTo: {
        type: 'string',
        format: 'uuid',
        nullable: true
      },
      content: {
        type: 'string'
      },
      render: {
        type: 'string',
        nullable: true,
        description: 'Rendered HTML. Null until the comments provider renders it.'
      },
      createdAt: {
        type: 'string',
        format: 'date-time'
      },
      updatedAt: {
        type: 'string',
        format: 'date-time'
      },
      replies: {
        type: 'array',
        items: { $ref: 'Comment#' },
        description: 'Direct replies to this comment, oldest first. Empty for a leaf.'
      }
    }
  })
}
