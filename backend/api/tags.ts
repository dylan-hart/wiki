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

/**
 * Tag API Routes
 *
 * Tags are derived from the pages that carry them rather than stored on their own — see
 * `models/tags.ts` for why.
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST TAGS
   */
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
      return WIKI.models.tags.getTags(req.params.siteId, {
        limit: req.query.limit,
        actor: WIKI.models.groups.actorForRequest(req)
      })
    }
  )

  /**
   * RENAME TAG (also how merge works — see `models/tags.ts#renameTag`)
   */
  app.patch<{ Params: { siteId: string; tag: string }; Body: { newTag: string } }>(
    '/sites/:siteId/tags/:tag',
    {
      // -> No route-level permissions: manage:pages is a page rule permission, checked per affected
      //    page below rather than declared here — see CLAUDE.md's Permissions section.
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
      const candidates = await WIKI.models.tags.pagesWithTag(req.params.siteId, req.params.tag)
      if (candidates.length < 1) {
        return reply.notFound('This tag does not exist on this site.')
      }
      const allowedIds = candidates
        .filter((page) => mayOnPage(req, 'manage:pages', req.params.siteId, page))
        .map((page) => page.id)
      const updated = await WIKI.models.tags.renameTag(
        req.params.siteId,
        req.params.tag,
        req.body.newTag,
        allowedIds
      )
      return { ok: true, updated: updated.length }
    }
  )

  /**
   * DELETE TAG
   */
  app.delete<{ Params: { siteId: string; tag: string } }>(
    '/sites/:siteId/tags/:tag',
    {
      // -> No route-level permissions: manage:pages is a page rule permission, checked per affected
      //    page below rather than declared here — see CLAUDE.md's Permissions section.
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
      const candidates = await WIKI.models.tags.pagesWithTag(req.params.siteId, req.params.tag)
      if (candidates.length < 1) {
        return reply.notFound('This tag does not exist on this site.')
      }
      const allowedIds = candidates
        .filter((page) => mayOnPage(req, 'manage:pages', req.params.siteId, page))
        .map((page) => page.id)
      const updated = await WIKI.models.tags.deleteTag(
        req.params.siteId,
        req.params.tag,
        allowedIds
      )
      return { ok: true, updated: updated.length }
    }
  )
}

export default routes
