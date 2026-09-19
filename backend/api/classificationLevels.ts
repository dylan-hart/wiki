import type { FastifyInstance } from 'fastify'

/**
 * Listing is public: the levels are picker metadata, not sensitive, and whoever needs to see a
 * page's or a rule's classification is not a fixed permission set. CRUD is `manage:system` only —
 * no global permission fits, and that list is closed.
 */
async function routes(app: FastifyInstance) {
  app.get(
    '/',
    {
      config: {
        publicAccess: true
      },
      schema: {
        summary: 'List classification levels',
        description: 'Most-open (lowest sortOrder) first.',
        tags: ['Classification'],
        response: {
          200: {
            description: 'Classification levels',
            type: 'array',
            items: { $ref: 'ClassificationLevel#' }
          }
        }
      }
    },
    async () => {
      return CARDINAL.models.classificationLevels.list()
    }
  )

  app.post<{ Body: { name: string } }>(
    '/',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Create a classification level',
        tags: ['Classification'],
        body: {
          allOf: [{ $ref: 'ClassificationLevelInput#' }, { type: 'object', required: ['name'] }]
        },
        response: {
          200: { description: 'Level created', $ref: 'ClassificationLevel#' },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.classificationLevels.create(req.body)
    }
  )

  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    '/:id',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Update a classification level',
        tags: ['Classification'],
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id']
        },
        body: { $ref: 'ClassificationLevelInput#' },
        response: {
          200: { description: 'Level updated', $ref: 'ClassificationLevel#' },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const updated = await CARDINAL.models.classificationLevels.update(req.params.id, req.body)
      if (!updated) {
        return reply.notFound('This classification level does not exist.')
      }
      return updated
    }
  )

  app.post<{ Body: { ids: string[] } }>(
    '/reorder',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Reorder every classification level at once',
        description: 'Assigns sortOrder = position in `ids`. Every existing level must be named.',
        tags: ['Classification'],
        body: {
          type: 'object',
          required: ['ids'],
          properties: { ids: { type: 'array', items: { type: 'string', format: 'uuid' } } }
        },
        response: {
          200: { type: 'array', items: { $ref: 'ClassificationLevel#' } },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const current = CARDINAL.models.classificationLevels.list()
      const currentIds = new Set(current.map((level) => level.id))
      const submittedIds = new Set(req.body.ids)
      if (
        req.body.ids.length !== current.length ||
        submittedIds.size !== req.body.ids.length ||
        !req.body.ids.every((id) => currentIds.has(id))
      ) {
        return reply.badRequest('ids must name every existing classification level exactly once.')
      }
      await CARDINAL.models.classificationLevels.reorder(req.body.ids)
      return CARDINAL.models.classificationLevels.list()
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Delete a classification level',
        description:
          'Refused with 400 when it is the last level left, and with 409 when any page, or any API key/token still capped at it, still carries it.',
        tags: ['Classification'],
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id']
        },
        response: {
          200: {
            type: 'object',
            properties: { ok: { type: 'boolean' } }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            $ref: 'ApiError#',
            description:
              'This classification level is still used by at least one page, or as an API key/token cap (`classificationInUse`).'
          }
        }
      }
    },
    async (req, reply) => {
      const deleted = await CARDINAL.models.classificationLevels.delete(req.params.id)
      if (!deleted) {
        return reply.notFound('This classification level does not exist.')
      }
      return { ok: true }
    }
  )
}

export default routes
