import { actorFromRequest } from '../models/auditLog.ts'
import type { FastifyInstance } from 'fastify'

async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/ai/providers',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List the AI providers available to a site',
        description:
          "One entry per AI provider module installed in `modules/ai`, whether or not it is the one currently selected. A provider's API key is masked; configuration can still include other provider settings, hence the `manage:system` requirement.",
        tags: ['AI'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'List of AI providers',
            type: 'array',
            items: { $ref: 'AiProvider#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.ai.getSiteProviders(req.params.siteId, { mask: true })
    }
  )

  app.put<{
    Params: { siteId: string }
    Body: { provider: string; config?: Record<string, any> }
  }>(
    '/sites/:siteId/ai',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: "Select a site's AI provider",
        description:
          "Makes the named provider the one this site's AI features call, and saves its config. An empty `provider` turns AI off for the site while keeping every provider's saved config. Values are validated against what the provider's `definition.yml` declares: an unrecognized key, a value of the wrong type or a `required` prop (the API key) left empty is refused, and nothing is written. Required checks run against the config that would actually end up stored, so a masked API key sent back unchanged keeps the stored one.",
        tags: ['AI'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          properties: {
            provider: {
              type: 'string',
              maxLength: 255,
              description: 'Directory name under `modules/ai`, or an empty string for none.'
            },
            config: {
              type: 'object',
              additionalProperties: true
            }
          },
          required: ['provider']
        },
        response: {
          200: {
            description: 'AI provider selection saved successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const { siteId } = req.params
      const key = req.body.provider
      const models = CARDINAL.models

      let title = ''
      if (key) {
        const definition = models.ai.getDefinition(key)
        if (!definition) {
          return reply.notFound(`AI provider "${key}" does not exist.`)
        }
        title = definition.title
        if (!(await models.ai.hasImplementation(key))) {
          return reply.badRequest(`${definition.title} has no implementation on this server.`)
        }
        const invalid = models.ai.validateProviderConfig(
          key,
          req.body.config,
          models.ai.getProviderConfig(siteId, key)
        )
        if (invalid) {
          return reply.badRequest(invalid)
        }
      }

      const saved = await models.ai.selectProvider(siteId, key, req.body.config)
      if (!saved) {
        return reply.internalServerError('Failed to save the AI provider.')
      }

      await models.auditLog.record({
        event: 'site.settingsUpdated',
        actor: actorFromRequest(req),
        targetType: 'site',
        targetId: siteId,
        targetLabel: CARDINAL.sites[siteId]?.config?.title,
        detail: { changedFields: ['ai'], provider: key },
        siteId
      })

      return {
        ok: true,
        message: key
          ? `${title} selected as the AI provider successfully.`
          : 'AI provider turned off successfully.'
      }
    }
  )
}

export default routes
