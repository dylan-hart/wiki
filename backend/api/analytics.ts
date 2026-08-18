import type { FastifyInstance } from 'fastify'

/**
 * Analytics API Routes
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST ANALYTICS MODULES
   */
  app.get(
    '/analytics/modules',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'List the analytics modules available on this server',
        description:
          'Read from `modules/analytics` at startup, so installing a module means dropping it on disk and restarting. Modules that declare themselves unavailable are not listed. Unlike authentication strategies, an analytics provider has no configuration of its own to keep track of instance-wide — whether it is enabled and what it is configured with lives directly on each site (`Site#/properties/analytics`), which is why this only requires `manage:sites` rather than `manage:system`.',
        tags: ['Analytics'],
        response: {
          200: {
            description: 'List of analytics modules',
            type: 'array',
            items: { $ref: 'AnalyticsModule#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return WIKI.models.analytics.getModules()
    }
  )
}

export default routes
