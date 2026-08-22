import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * CHECKLIST ITEM CHECK - one item checked off within an execution, who did it and when.
   */
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

  /**
   * CHECKLIST EXECUTION - one run of a checklist, with every item checked off inside it. What the
   * per-execution view (OpenProject #869's "run started at X, completed by Y, N of M items checked")
   * is built from: `checkedCount`/`itemCount` give N of M, `completedAt`/`completedByName` give Y,
   * `startedAt`/`startedByName` give X.
   */
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
   * CHECKLIST EXECUTION SUMMARY - one row of the run history listing. Same shape as
   * `ChecklistExecution` minus `items`, which the listing omits so paging through history does not
   * pull every checked item of every run in one response — a caller wanting those loads one
   * execution's full detail instead.
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
   * CHECKLIST ITEM CHECK INPUT - the body of a check-off request. `itemCount` travels with every
   * check rather than living only on a separate "start" call, since the block itself is the only
   * thing that knows how many items its own content currently has — see `models/checklists.ts`'s
   * `checkItem`.
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
