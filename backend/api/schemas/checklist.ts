import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'ChecklistItemCheck',
    type: 'object',
    properties: {
      itemKey: { type: 'string' },
      checkedAt: { type: 'string', format: 'date-time' },
      checkedBy: { type: 'string', format: 'uuid', nullable: true },
      checkedByName: {
        type: 'string',
        nullable: true,
        description: 'The account name at check time, or null once the account is gone.'
      }
    }
  })

  app.addSchema({
    $id: 'ChecklistExecution',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      siteId: { type: 'string', format: 'uuid' },
      pageId: { type: 'string', format: 'uuid' },
      blockKey: { type: 'string' },
      itemCount: { type: 'integer' },
      startedAt: { type: 'string', format: 'date-time' },
      startedBy: { type: 'string', format: 'uuid', nullable: true },
      startedByName: { type: 'string', nullable: true },
      completedAt: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description:
          'Set once every item has been checked. Null while the run is still in progress.'
      },
      completedBy: { type: 'string', format: 'uuid', nullable: true },
      completedByName: { type: 'string', nullable: true },
      checkedCount: { type: 'integer' },
      items: {
        type: 'array',
        items: { $ref: 'ChecklistItemCheck#' }
      }
    }
  })

  /**
   * `ChecklistExecution` minus `items`, so paging through the run history does not pull every
   * run's checked items.
   */
  app.addSchema({
    $id: 'ChecklistExecutionSummary',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      siteId: { type: 'string', format: 'uuid' },
      pageId: { type: 'string', format: 'uuid' },
      blockKey: { type: 'string' },
      itemCount: { type: 'integer' },
      startedAt: { type: 'string', format: 'date-time' },
      startedBy: { type: 'string', format: 'uuid', nullable: true },
      startedByName: { type: 'string', nullable: true },
      completedAt: { type: 'string', format: 'date-time', nullable: true },
      completedBy: { type: 'string', format: 'uuid', nullable: true },
      completedByName: { type: 'string', nullable: true },
      checkedCount: { type: 'integer' }
    }
  })

  /**
   * `itemCount` travels with every check rather than on a separate "start" call: only the block
   * knows how many items its content currently has.
   */
  app.addSchema({
    $id: 'ChecklistItemCheckInput',
    type: 'object',
    properties: {
      itemKey: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        description: 'The item\'s position key within the checklist, e.g. "item-0".'
      },
      itemCount: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        description:
          'Total items in the checklist right now. Only used to start a new execution when none is ' +
          "active; ignored otherwise, so an execution's target count never changes mid-run."
      }
    },
    required: ['itemKey', 'itemCount']
  })
}
