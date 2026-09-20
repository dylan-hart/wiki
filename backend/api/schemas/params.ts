import type { FastifyInstance } from 'fastify'

/**
 * Only the purely "which site / which thing in it" shapes live here; a route whose params carry
 * anything else (a `kind`, an `alias`, an `action`) keeps its own literal.
 *
 * `required` only marks the parameter required in the OpenAPI document — a path param is always
 * present at runtime, so it is not a check that can fail.
 */
export async function registerParamsSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'SiteIdParams',
    type: 'object',
    properties: { siteId: { type: 'string', format: 'uuid' } },
    required: ['siteId']
  })

  app.addSchema({
    $id: 'SitePageParams',
    type: 'object',
    properties: {
      siteId: { type: 'string', format: 'uuid' },
      pageId: { type: 'string', format: 'uuid' }
    },
    required: ['siteId', 'pageId']
  })

  app.addSchema({
    $id: 'SiteFolderParams',
    type: 'object',
    properties: {
      siteId: { type: 'string', format: 'uuid' },
      folderId: { type: 'string', format: 'uuid' }
    },
    required: ['siteId', 'folderId']
  })

  app.addSchema({
    $id: 'SiteTagParams',
    type: 'object',
    properties: {
      siteId: { type: 'string', format: 'uuid' },
      tag: { type: 'string' }
    },
    required: ['siteId', 'tag']
  })

  app.addSchema({
    $id: 'SitePageCommentParams',
    type: 'object',
    properties: {
      siteId: { type: 'string', format: 'uuid' },
      pageId: { type: 'string', format: 'uuid' },
      commentId: { type: 'string', format: 'uuid' }
    },
    required: ['siteId', 'pageId', 'commentId']
  })
}
