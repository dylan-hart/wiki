import type { FastifyInstance } from 'fastify'

/**
 * Classification Levels API Routes (OpenProject #1079)
 *
 * Listing is public-access: the level list is picker metadata (a page's classification, a group
 * rule's `classifications`), not itself sensitive, and is needed by anyone with a reason to see a
 * page's or a rule's classification — which is not a fixed permission set. CRUD is `manage:system`
 * only, the same gate `api/icons.ts` uses for its own admin-only set management, since there is no
 * existing global permission that fits ("an admin-configurable list an ordinary editor never touches")
 * and inventing a new one is not warranted for a single small admin screen — see CLAUDE.md's
 * Permissions section on the closed global-permission list.
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST LEVELS
   */
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
      return WIKI.models.classificationLevels.list()
    }
  )

  /**
   * CREATE LEVEL
   */
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
      return WIKI.models.classificationLevels.create(req.body)
    }
  )

  /**
   * UPDATE LEVEL
   */
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
      const updated = await WIKI.models.classificationLevels.update(req.params.id, req.body)
      if (!updated) {
        return reply.notFound('This classification level does not exist.')
      }
      return updated
    }
  )

  /**
   * REORDER LEVELS
   */
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
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      await WIKI.models.classificationLevels.reorder(req.body.ids)
      return WIKI.models.classificationLevels.list()
    }
  )

  /**
   * DELETE LEVEL
   */
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
      const deleted = await WIKI.models.classificationLevels.delete(req.params.id)
      if (!deleted) {
        return reply.notFound('This classification level does not exist.')
      }
      return { ok: true }
    }
  )
}

export default routes
