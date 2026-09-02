import type { FastifyInstance } from 'fastify'

/**
 * The path-parameter shapes a site-scoped route addresses its subject with (finding API-F4).
 *
 * Every other schema slot on a route — `body`, `response` — already reaches for a shared `$ref` out of
 * this directory. `params` was the one that never did, so the same five object literals were written
 * out ~70 times across 20 route files, in three different formattings of the identical thing, plus a
 * per-file `const siteIdParam`/`pageIdParam`/`folderIdParam` in six of them. A route now writes
 * `params: { $ref: 'SiteIdParams#' }`.
 *
 * Only the shapes that are purely "which site / which thing in it" live here. A route whose params
 * carry anything else — a `kind`, an `alias`, an `action`, a `pageIdOrHash` with its own description —
 * keeps its literal, because the extra key is genuinely that route's own and a shared id per one-off
 * combination would trade one duplication for a directory of near-namesakes.
 *
 * `required` is declared for the same reason the literals declared it: it is what makes the OpenAPI
 * document mark the parameter required. A path param is always present at runtime by construction —
 * Fastify cannot route to `/sites/:siteId/...` without one — so this is documentation, not a check
 * that can fail.
 */
export async function registerParamsSchemas(app: FastifyInstance): Promise<void> {
  /** A route scoped to one site and nothing narrower. */
  app.addSchema({
    $id: 'SiteIdParams',
    type: 'object',
    properties: { siteId: { type: 'string', format: 'uuid' } },
    required: ['siteId']
  })

  /** A route scoped to one page of one site. */
  app.addSchema({
    $id: 'SitePageParams',
    type: 'object',
    properties: {
      siteId: { type: 'string', format: 'uuid' },
      pageId: { type: 'string', format: 'uuid' }
    },
    required: ['siteId', 'pageId']
  })

  /** A route scoped to one tree folder of one site. */
  app.addSchema({
    $id: 'SiteFolderParams',
    type: 'object',
    properties: {
      siteId: { type: 'string', format: 'uuid' },
      folderId: { type: 'string', format: 'uuid' }
    },
    required: ['siteId', 'folderId']
  })

  /** A route scoped to one tag on one site — a tag is its own string, not an id. */
  app.addSchema({
    $id: 'SiteTagParams',
    type: 'object',
    properties: {
      siteId: { type: 'string', format: 'uuid' },
      tag: { type: 'string' }
    },
    required: ['siteId', 'tag']
  })

  /** A route scoped to one comment on one page of one site. */
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
