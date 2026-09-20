import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * The site-wide moderation listing's flat, cross-page shape. Named `AdminComment` so its id does
   * not collide with `Comment#`, which is shaped around a single page's thread.
   */
  app.addSchema({
    $id: 'AdminComment',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      siteId: { type: 'string', format: 'uuid' },
      pageId: { type: 'string', format: 'uuid' },
      pagePath: { type: 'string' },
      authorId: { type: ['string', 'null'], format: 'uuid' },
      authorName: {
        type: 'string',
        description: 'The account name when `authorId` is set, the guest-supplied name otherwise.'
      },
      replyTo: { type: ['string', 'null'], format: 'uuid' },
      content: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  })

  /**
   * Whether `guestName`/`guestEmail` are required or refused depends on the session, which a JSON
   * Schema cannot see: only their shape is enforced here, the rest in the route handler.
   */
  app.addSchema({
    $id: 'CommentInput',
    type: 'object',
    properties: {
      content: {
        type: 'string',
        minLength: 1,
        maxLength: 32768,
        description: 'The comment source, in whatever format the comments provider renders.'
      },
      replyTo: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description:
          'The comment being replied to, on the same page. Omit or null for a top-level comment.'
      },
      guestName: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        description:
          'Display name for an unauthenticated poster. Required when posting without a session; ' +
          'rejected with 400 when posting with one, where the account name is used instead.'
      },
      guestEmail: {
        type: 'string',
        format: 'email',
        maxLength: 255,
        description:
          'Contact email for an unauthenticated poster, for abuse follow-up — never shown to other ' +
          'readers. Required when posting without a session; rejected with 400 when posting with one.'
      }
    },
    required: ['content']
  })

  /**
   * PATCH only ever changes `content`. The other three are declared so they stay on `req.body` for
   * the handler to refuse with a 400: ajv runs with Fastify's default `removeAdditional: true`,
   * which silently deletes an undeclared property instead of rejecting the request.
   */
  app.addSchema({
    $id: 'CommentUpdateInput',
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
        description: 'Not editable via PATCH. Present only so a request that sets it gets a 400.'
      },
      guestName: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        description: 'Not editable via PATCH. Present only so a request that sets it gets a 400.'
      },
      guestEmail: {
        type: 'string',
        format: 'email',
        maxLength: 255,
        description: 'Not editable via PATCH. Present only so a request that sets it gets a 400.'
      }
    },
    required: ['content'],
    additionalProperties: false
  })

  /**
   * `authorId` is null for a guest comment. `authorEmail` is null from every route except the
   * response to posting a comment, which shows the poster their own address back.
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
      canEdit: {
        type: 'boolean',
        description:
          'Whether the requester may edit this comment: the author, or a holder of `manage:comments` on the page.'
      },
      canDelete: {
        type: 'boolean',
        description:
          'Whether the requester may delete this comment: the author, or a holder of `manage:comments` on the page.'
      },
      replies: {
        type: 'array',
        items: { $ref: 'Comment#' },
        description: 'Direct replies to this comment, oldest first. Empty for a leaf.'
      }
    }
  })
}
