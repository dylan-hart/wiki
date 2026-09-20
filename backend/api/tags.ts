import type { FastifyInstance } from 'fastify'
import { mayOnPage } from '../helpers/pageAccess.ts'

const tagActionResponse = {
  type: 'object',
  properties: {
    ok: {
      type: 'boolean'
    },
    updated: {
      type: 'integer',
      description:
        'How many pages were actually changed — pages the caller lacked manage:pages on are left untouched rather than failing the call.'
    }
  }
}

/** Tags are derived from the pages that carry them, not stored: see `models/tags.ts` for why. */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string }; Querystring: { limit?: number } }>(
    '/sites/:siteId/tags',
    {
      /*
        No route-level `permissions`: a tag exists because a readable page carries it, so the answer
        is filtered per page below rather than refused outright.
      */
      schema: {
        summary: 'List the tags in use on a site',
        description:
          'Every tag carried by at least one page the caller may read, most used first, counted over those pages only. This is what the tag field offers as suggestions while a page is being edited, and what the search screen filters by.',
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 5000,
              default: 1000
            }
          }
        },
        response: {
          200: {
            description: 'Tags in use, most used first',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tag: {
                  type: 'string'
                },
                usageCount: {
                  type: 'integer',
                  description: 'How many pages carry the tag.'
                }
              }
            }
          }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.tags.getTags(req.params.siteId, {
        limit: req.query.limit,
        actor: CARDINAL.models.groups.actorForRequest(req)
      })
    }
  )

  // -> The static `popular` segment cannot collide with the `:tag` routes below: neither is a GET.
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/tags/popular',
    {
      // -> No route-level `permissions`, as for the listing above: filtered per page.
      schema: {
        summary: 'List the most active tags on a site',
        description:
          "Up to 10 tags carried by at least one page the caller may read that was created or updated in the last 60 days, most active first, counted over those pages only. This is what the header search panel's Popular Tags widget renders — ranked by recent activity, not lifetime usage, unlike GET /sites/:siteId/tags.",
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Most active tags, most active first',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tag: {
                  type: 'string'
                },
                usageCount: {
                  type: 'integer',
                  description:
                    'How many pages carry the tag, created or updated in the last 60 days.'
                }
              }
            }
          }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.tags.getPopularTags(req.params.siteId, {
        actor: CARDINAL.models.groups.actorForRequest(req)
      })
    }
  )

  app.patch<{ Params: { siteId: string; tag: string }; Body: { newTag: string } }>(
    '/sites/:siteId/tags/:tag',
    {
      // -> No route-level permissions: manage:pages is a page rule permission, checked per page.
      schema: {
        summary: 'Rename a tag across every page that carries it',
        description:
          'Renames :tag to newTag on every page of this site the caller holds manage:pages on. A page that already carries newTag ends up with one entry, not two — this is also how merging two tags into one works. Pages the caller lacks manage:pages on are left untouched rather than failing the call.',
        tags: ['Pages'],
        params: { $ref: 'SiteTagParams#' },
        body: {
          type: 'object',
          required: ['newTag'],
          properties: {
            newTag: {
              type: 'string',
              minLength: 1
            }
          }
        },
        response: {
          200: tagActionResponse,
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const candidates = await CARDINAL.models.tags.pagesWithTag(req.params.siteId, req.params.tag)
      if (candidates.length < 1) {
        return reply.notFound('This tag does not exist on this site.')
      }
      const allowedIds = candidates
        .filter((page) => mayOnPage(req, 'manage:pages', req.params.siteId, page))
        .map((page) => page.id)
      const updated = await CARDINAL.models.tags.renameTag(
        req.params.siteId,
        req.params.tag,
        req.body.newTag,
        allowedIds
      )
      return { ok: true, updated: updated.length }
    }
  )

  app.delete<{ Params: { siteId: string; tag: string } }>(
    '/sites/:siteId/tags/:tag',
    {
      // -> No route-level permissions: manage:pages is a page rule permission, checked per page.
      schema: {
        summary: 'Remove a tag from every page that carries it',
        description:
          'Removes :tag from every page of this site the caller holds manage:pages on. Pages the caller lacks manage:pages on are left untouched rather than failing the call.',
        tags: ['Pages'],
        params: { $ref: 'SiteTagParams#' },
        response: {
          200: tagActionResponse,
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const candidates = await CARDINAL.models.tags.pagesWithTag(req.params.siteId, req.params.tag)
      if (candidates.length < 1) {
        return reply.notFound('This tag does not exist on this site.')
      }
      const allowedIds = candidates
        .filter((page) => mayOnPage(req, 'manage:pages', req.params.siteId, page))
        .map((page) => page.id)
      const updated = await CARDINAL.models.tags.deleteTag(
        req.params.siteId,
        req.params.tag,
        allowedIds
      )
      return { ok: true, updated: updated.length }
    }
  )
}

export default routes
