import { actorFromRequest } from '../models/auditLog.ts'
import { AI_ASSIST_MAX_DAILY_CAP, aiAssistDailyCap, aiAssistEnabled } from '../helpers/aiAssist.ts'
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

  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/ai',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: "Get a site's AI settings",
        description:
          "The selected provider's key (an empty string for none) and the Markdown editor's writing assistant settings. `assist` turns the assistant on for the site, and `assistDailyCap` is how many assistant actions each user may run per 24-hour window. Both spend the provider's API key, which is why they live here beside it and need `manage:system`, rather than under the delegable `features` settings.",
        tags: ['AI'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: "The site's AI settings",
            type: 'object',
            properties: {
              provider: { type: 'string' },
              assist: { type: 'boolean' },
              assistDailyCap: { type: 'integer' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      const siteConfig = CARDINAL.sites[req.params.siteId]?.config as
        | Record<string, any>
        | undefined
      return {
        provider: CARDINAL.models.ai.getSelectedKey(req.params.siteId),
        assist: aiAssistEnabled(siteConfig),
        assistDailyCap: aiAssistDailyCap(siteConfig)
      }
    }
  )

  app.put<{
    Params: { siteId: string }
    Body: {
      provider: string
      config?: Record<string, any>
      assist?: boolean
      assistDailyCap?: number
    }
  }>(
    '/sites/:siteId/ai',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: "Select a site's AI provider and writing assistant settings",
        description:
          "Makes the named provider the one this site's AI features call, and saves its config along with the optional writing assistant settings `assist` and `assistDailyCap`. An empty `provider` turns AI off for the site while keeping every provider's saved config. Values are validated against what the provider's `definition.yml` declares: an unrecognized key, a value of the wrong type or a `required` prop (the API key) left empty is refused, and nothing is written. Required checks run against the config that would actually end up stored, so a masked API key sent back unchanged keeps the stored one.",
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
            },
            assist: {
              type: 'boolean',
              description:
                "Whether the Markdown editor's writing assistant (rewrite, summarize, expand, generate from a prompt) is offered on this site. Off by default. Turning it on grants nobody a permission: a user still needs `write:pages` on the page, a provider must be available, and each user is held to `assistDailyCap`. Saved even when `provider` is empty. Omit it to leave the stored value unchanged."
            },
            assistDailyCap: {
              type: 'integer',
              minimum: 1,
              maximum: AI_ASSIST_MAX_DAILY_CAP,
              description:
                'How many writing assistant actions each user may run on this site per 24-hour window. The window is fixed and starts at the first action. Omit it to leave the stored value unchanged.'
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

      const assistSettings = {
        assist: req.body.assist,
        assistDailyCap: req.body.assistDailyCap
      }
      const saved = await models.ai.selectProvider(siteId, key, req.body.config, assistSettings)
      if (!saved) {
        return reply.internalServerError('Failed to save the AI provider.')
      }

      await models.auditLog.record({
        event: 'site.settingsUpdated',
        actor: actorFromRequest(req),
        targetType: 'site',
        targetId: siteId,
        targetLabel: CARDINAL.sites[siteId]?.config?.title,
        detail: {
          changedFields: ['ai'],
          provider: key,
          ...(assistSettings.assist !== undefined ? { assist: assistSettings.assist } : {}),
          ...(assistSettings.assistDailyCap !== undefined
            ? { assistDailyCap: assistSettings.assistDailyCap }
            : {})
        },
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
