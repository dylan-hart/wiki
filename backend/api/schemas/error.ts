import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /** The shape `helpers/errorHandler.ts#apiErrorHandler` sends every `/_api` failure as. */
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
