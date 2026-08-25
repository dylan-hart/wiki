import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * CLASSIFICATION LEVEL - One admin-configurable sensitivity level (OpenProject #1079)
   */
  app.addSchema({
    $id: 'ClassificationLevel',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      sortOrder: {
        type: 'integer',
        description: 'Lower is more open. Public is 0 in the seeded defaults.'
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  })

  app.addSchema({
    $id: 'ClassificationLevelInput',
    type: 'object',
    properties: {
      // -> No `sortOrder` (OpenProject #1651): `create()` always appends after the current max, and
      //    `update()` has no way to set it at all -- `reorder()` is the only route that reassigns
      //    `sortOrder`, so there is no per-level input a caller could collide another level with.
      name: { type: 'string', minLength: 1, maxLength: 255 }
    }
  })
}
