import type { FastifyInstance } from 'fastify'

interface GlossaryTermBody {
  term?: string
  definition?: string
  aliases?: string[]
  pageId?: string | null
}

/**
 * Glossary API Routes (OpenProject #870)
 *
 * The admin list/create/update/delete routes are gated behind `manage:sites`, matching every other
 * site-config surface that has no delegated `site:*` permission of its own (see CLAUDE.md's
 * Permissions section). `GET .../terms` is the one exception: it carries no route-level permission,
 * the same way `api/tags.ts` doesn't, because it is what the editor's own live preview and save-time
 * render pull from to match against — refusing it there would refuse rendering, not just the admin
 * screen.
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST GLOSSARY TERMS
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/glossary',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'List a site’s glossary terms',
        tags: ['Glossary'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId']
        },
        response: {
          200: {
            description: 'Glossary terms, alphabetical',
            type: 'array',
            items: { $ref: 'GlossaryTerm#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!WIKI.sites[req.params.siteId]) {
        return reply.notFound('This site does not exist.')
      }
      return WIKI.models.glossary.listTerms(req.params.siteId)
    }
  )

  /**
   * LIST RESOLVED TERMS FOR RENDERING
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/glossary/terms',
    {
      /*
        No route-level permissions, and genuinely public -- a term's name and definition are not
        gated content, the same way an Iconify icon isn't (see CLAUDE.md's Icons section). This is
        the cached, resolved list the rendering pipeline matches against (see
        `renderers/modules/markdown-it-glossary.js`), fetched by the editor itself so its live preview
        and the render it saves stay in step with what a reader will eventually see.
      */
      schema: {
        summary: 'List the resolved glossary terms the rendering pipeline matches against',
        description:
          'Cached, and invalidated on every term create/update/delete. Empty when the site has no glossary terms defined — which is also how the feature degrades to plain text.',
        tags: ['Glossary'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId']
        },
        response: {
          200: {
            description: 'Resolved glossary terms',
            type: 'array',
            items: { $ref: 'GlossaryRenderTerm#' }
          },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!WIKI.sites[req.params.siteId]) {
        return reply.notFound('This site does not exist.')
      }
      return WIKI.models.glossary.getCachedTerms(req.params.siteId)
    }
  )

  /**
   * CREATE GLOSSARY TERM
   */
  app.post<{ Params: { siteId: string }; Body: GlossaryTermBody }>(
    '/sites/:siteId/glossary',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'Create a glossary term',
        tags: ['Glossary'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId']
        },
        body: {
          allOf: [
            { $ref: 'GlossaryTermInput#' },
            { type: 'object', required: ['term', 'definition'] }
          ]
        },
        response: {
          200: { $ref: 'GlossaryTerm#' },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!WIKI.sites[req.params.siteId]) {
        return reply.notFound('This site does not exist.')
      }
      return WIKI.models.glossary.createTerm(req.params.siteId, {
        term: req.body.term!,
        definition: req.body.definition!,
        aliases: req.body.aliases,
        pageId: req.body.pageId
      })
    }
  )

  /**
   * UPDATE GLOSSARY TERM
   */
  app.put<{ Params: { siteId: string; termId: string }; Body: GlossaryTermBody }>(
    '/sites/:siteId/glossary/:termId',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'Update a glossary term',
        description: 'Accepts any subset of the fields.',
        tags: ['Glossary'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            termId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'termId']
        },
        body: { $ref: 'GlossaryTermInput#' },
        response: {
          200: { $ref: 'GlossaryTerm#' },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!WIKI.sites[req.params.siteId]) {
        return reply.notFound('This site does not exist.')
      }
      return WIKI.models.glossary.updateTerm(req.params.siteId, req.params.termId, {
        term: req.body.term,
        definition: req.body.definition,
        aliases: req.body.aliases,
        pageId: req.body.pageId
      })
    }
  )

  /**
   * DELETE GLOSSARY TERM
   */
  app.delete<{ Params: { siteId: string; termId: string } }>(
    '/sites/:siteId/glossary/:termId',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'Delete a glossary term',
        tags: ['Glossary'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            termId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'termId']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!WIKI.sites[req.params.siteId]) {
        return reply.notFound('This site does not exist.')
      }
      const deleted = await WIKI.models.glossary.deleteTerm(req.params.siteId, req.params.termId)
      if (!deleted) {
        return reply.notFound('This glossary term does not exist.')
      }
      return { ok: true }
    }
  )
}

export default routes
