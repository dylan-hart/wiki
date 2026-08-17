import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * ADMIN COMMENT - A comment as the site-wide moderation listing (Task 625, Feature 394) hands it
   * back. Named `AdminComment` rather than `Comment` deliberately: `feature/comments-rest-api`
   * (Feature 391, not merged into this branch) has its own page-scoped comment routes and will want a
   * `Comment#` schema of its own for them, shaped around a single page's thread rather than a flat,
   * cross-page, filtered page. Keeping the ids distinct avoids a collision when that branch merges;
   * reconciling the two into one shape, if warranted, is that merge's call to make.
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
}
