import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * ANALYTICS MODULE - An analytics provider as found on disk
   */
  app.addSchema({
    $id: 'AnalyticsModule',
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Directory name under `modules/analytics`.'
      },
      title: {
        type: 'string'
      },
      description: {
        type: 'string'
      },
      logo: {
        type: 'string'
      },
      website: {
        type: 'string'
      },
      isAvailable: {
        type: 'boolean'
      },
      props: {
        type: 'object',
        additionalProperties: true,
        description:
          'The provider configuration, declared in its `definition.yml`: each entry carries a `type`, `title`, `hint`, `default` and the display hints the admin area renders a control from.'
      }
    }
  })
}
