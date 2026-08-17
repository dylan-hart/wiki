import type { FastifyInstance } from 'fastify'

/**
 * Comments API Routes
 *
 * Task 617 (Feature 394, "Admin comments management UI rebuild"): which comment provider is active
 * for a site, and what it is configured with. This is the whole of this file for now — the
 * page-scoped comment CRUD routes (`GET/POST/PATCH/DELETE .../pages/:pageId/comments`) are Feature
 * 391's own task, built independently on a sibling branch not yet merged into this one. When that
 * lands, its routes join this file rather than living in a second one.
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST A SITE'S COMMENT PROVIDERS
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/comments/providers',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: "List a site's comment providers",
        description:
          'One entry per comments module installed in `modules/comments`, whether or not it has ever been enabled — same pattern as `GET /sites/:siteId/storage/targets`. At most one entry has `isEnabled` true: comments have a single active provider per site, not several simultaneous targets.',
        tags: ['Comments'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId']
        },
        response: {
          200: {
            description: 'List of comment providers',
            type: 'array',
            items: { $ref: 'CommentProvider#' }
          }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      return WIKI.models.commentProviders.getSiteProviders(req.params.siteId)
    }
  )

  /**
   * SET THE ACTIVE COMMENT PROVIDER
   */
  app.put<{ Params: { siteId: string }; Body: { module: string; config?: Record<string, any> } }>(
    '/sites/:siteId/comments/providers',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: "Set a site's active comment provider",
        description:
          'Activates the named module and stores its config values, disabling whichever provider was active before. There is exactly one active provider per site at any time; there is no endpoint to turn comments off short of activating a module and leaving its config at defaults, since "no provider active" is not itself a supported state past initial site creation.',
        tags: ['Comments'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId']
        },
        body: { $ref: 'CommentProviderInput#' },
        response: {
          200: {
            description: 'The provider now active, as stored',
            $ref: 'CommentProvider#'
          }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      try {
        const provider = await WIKI.models.commentProviders.setActiveProvider(
          req.params.siteId,
          req.body.module,
          req.body.config ?? {}
        )
        if (!provider) {
          return reply.notFound(`No such comment provider module: ${req.body.module}`)
        }
        return provider
      } catch (err: any) {
        return reply.badRequest(err.message)
      }
    }
  )
}

export default routes
