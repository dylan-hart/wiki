import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
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

  /**
   * COMMENT MODERATION ITEM - A comment as the site-wide moderation list (task 611) hands it back
   *
   * Flat rather than nested under `replies` — the moderation queue this serves reads rows across
   * unrelated pages, not one page's thread, so there is no single parent to nest a reply under. Adds
   * `page` (`path`/`title`) so a moderation UI can link back to the source page without a second
   * request per row. `authorEmail` is populated, unlike the per-page list's `Comment#`: reaching this
   * endpoint at all already requires `manage:comments`, so unlike a page-view reader (who may be
   * anonymous), every caller here is already a moderator.
   */
  app.addSchema({
    $id: 'CommentModerationItem',
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
      page: {
        type: 'object',
        description: "Just enough of the comment's page to link back to it.",
        properties: {
          path: { type: 'string' },
          title: { type: 'string' }
        }
      }
    }
  })
}
