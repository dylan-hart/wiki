import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * ADMIN COMMENT - A comment as the site-wide moderation listing (Task 625, Feature 394) hands it
   * back. Named `AdminComment` rather than `Comment` deliberately: the page-scoped comment routes
   * (Feature 391) have their own `Comment#` schema, shaped around a single page's thread rather than
   * a flat, cross-page, filtered page. Keeping the ids distinct avoids a schema collision between them.
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
   * COMMENT INPUT - The writable fields when posting a comment
   *
   * `guestName`/`guestEmail` are only for an unauthenticated poster (task 609, "guest posting"), and
   * their presence requirement flips depending on the requester: required when `actorFrom(req)` is
   * null, forbidden (400, not silently dropped) when it isn't. That split depends on the session, which
   * a JSON Schema has no visibility into, so only the shape each field must have when present — a
   * non-empty name, an RFC-5322-shaped email — is enforced here; whether either is required or
   * forbidden at all is `comments.ts`'s job, in the route handler, once it knows which branch applies.
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
   * COMMENT - A single comment, with its direct replies nested under it
   *
   * `authorId` is null for a guest comment; `authorName` is resolved from the account for a logged in
   * author and from the stored guest fields otherwise, so a caller reading a comment never needs to
   * branch on which kind it is. `authorEmail` is deliberately left unset (rather than populated) by
   * every route except the response to posting a comment, since that is the poster being shown their
   * own address back — see `api/comments.ts`'s `resolveAuthorName`/POST route for exactly where.
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
