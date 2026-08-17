import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * API ERROR - The shape every `/_api` failure is sent as, per `setErrorHandler` in `index.ts`.
   * Shared by every route's 4xx/5xx `response` entries rather than declared inline per route.
   */
  app.addSchema({
    $id: 'ApiError',
    type: 'object',
    required: ['ok', 'error', 'statusCode', 'message'],
    properties: {
      ok: {
        type: 'boolean',
        description: 'Always false — this is the shape an error takes, never a success.'
      },
      error: {
        type: 'string',
        description: 'The error class name, e.g. `Unauthorized`, `Forbidden`, `NotFound`.'
      },
      statusCode: {
        type: 'integer'
      },
      message: {
        type: 'string'
      }
    }
  })
}
