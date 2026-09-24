import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'TaskRollupItem',
    type: 'object',
    properties: {
      index: {
        type: 'integer',
        description:
          'The item’s ordinal on its page: the `:index` PUT /sites/:siteId/pages/:pageId/tasks/:index takes.'
      },
      text: {
        type: 'string',
        description:
          'The item’s markdown source after the marker, for a caller who may read the page’s source (`read:source`, `write:pages` or `manage:pages`); otherwise only its visible text, without inline HTML or link targets.'
      },
      line: { type: 'integer', description: 'Zero-based source line of the item.' }
    }
  })

  app.addSchema({
    $id: 'TaskRollupPage',
    type: 'object',
    properties: {
      pageId: { type: 'string', format: 'uuid' },
      path: { type: 'string' },
      locale: { type: 'string' },
      title: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'What the tick route takes as `expectedUpdatedAt`.'
      },
      items: { type: 'array', items: { $ref: 'TaskRollupItem#' } }
    }
  })

  app.addSchema({
    $id: 'TaskRollup',
    type: 'object',
    properties: {
      results: { type: 'array', items: { $ref: 'TaskRollupPage#' } },
      totalHits: {
        type: 'integer',
        description: 'How many pages hold an unchecked item, ignoring `limit` and `offset`.'
      },
      totalItems: {
        type: 'integer',
        description: 'How many unchecked items those pages hold, ignoring `limit` and `offset`.'
      }
    }
  })
}
