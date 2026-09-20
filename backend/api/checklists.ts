import { actorFrom, mayOnPage, requireReadablePage } from '../helpers/pageAccess.ts'
import type { FastifyInstance } from 'fastify'

/**
 * Backs `block-checklist`: who checked which item of a checklist, and when. A run log, not
 * editorial content — it touches neither page history nor the approvals workflow.
 */
const blockKeyParam = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    pageId: { type: 'string', format: 'uuid' },
    blockKey: { type: 'string', minLength: 1, maxLength: 255 }
  },
  required: ['siteId', 'pageId', 'blockKey']
}

const executionIdParam = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    pageId: { type: 'string', format: 'uuid' },
    blockKey: { type: 'string', minLength: 1, maxLength: 255 },
    executionId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId', 'pageId', 'blockKey', 'executionId']
}

async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string; pageId: string; blockKey: string } }>(
    '/sites/:siteId/pages/:pageId/checklist/:blockKey/executions',
    {
      // No route-level `permissions`: `read:pages` is a page-rule permission, decided per page.
      schema: {
        summary: 'List a checklist block’s run history',
        description:
          'Every execution of this checklist block, most recently started first, without their item ' +
          'checks — request one execution by id for those.',
        tags: ['Checklists'],
        params: blockKeyParam,
        response: {
          200: {
            description: 'Run history for this checklist block',
            type: 'array',
            items: { $ref: 'ChecklistExecutionSummary#' }
          },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply
      }
      return CARDINAL.models.checklists.listExecutions(page.id, req.params.blockKey)
    }
  )

  app.get<{ Params: { siteId: string; pageId: string; blockKey: string } }>(
    '/sites/:siteId/pages/:pageId/checklist/:blockKey/executions/latest',
    {
      // No route-level `permissions`: same as the history listing above.
      schema: {
        summary: 'Get a checklist block’s most recently started run',
        description:
          'The execution the block itself renders against, item checks included. Null when this ' +
          'checklist has never been run.',
        tags: ['Checklists'],
        params: blockKeyParam,
        response: {
          /*
            Deliberately unvalidated: fast-json-stringify cannot express "a `$ref` object or bare
            `null`" at the top level — `{ $ref, nullable: true }` serializes `null` as `{}`, and
            `oneOf: [{ $ref }, { type: 'null' }]` throws on the object case.
          */
          200: {
            description: 'The most recently started execution as `ChecklistExecution#`, or null'
          },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply
      }
      return CARDINAL.models.checklists.getLatestExecution(page.id, req.params.blockKey)
    }
  )

  app.get<{ Params: { siteId: string; pageId: string; blockKey: string; executionId: string } }>(
    '/sites/:siteId/pages/:pageId/checklist/:blockKey/executions/:executionId',
    {
      // No route-level `permissions`: same as the history listing above.
      schema: {
        summary: 'Get one checklist execution',
        description:
          'A single past (or current) run of this checklist block, item checks included.',
        tags: ['Checklists'],
        params: executionIdParam,
        response: {
          200: { description: 'The execution', $ref: 'ChecklistExecution#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply
      }
      const execution = await CARDINAL.models.checklists.getExecutionDetail(req.params.executionId)
      // -> The lookup is by id alone: one from another page or block must 404 like a missing one,
      //    not leak that run log to a reader who can only read THIS page.
      if (
        !execution ||
        execution.pageId !== page.id ||
        execution.blockKey !== req.params.blockKey
      ) {
        return reply.notFound('This checklist execution does not exist.')
      }
      return execution
    }
  )

  app.post<{
    Params: { siteId: string; pageId: string; blockKey: string }
    Body: { itemKey: string; itemCount: number }
  }>(
    '/sites/:siteId/pages/:pageId/checklist/:blockKey/items',
    {
      // No route-level `permissions`: `write:pages` is a page-rule permission, decided per page.
      schema: {
        summary: 'Check off a checklist item',
        description:
          'Records that the signed-in user checked this item, starting a new execution first if none ' +
          'is currently active. Idempotent: checking an already-checked item in the active execution ' +
          'changes nothing. Requires a signed-in account — there is no guest identity to attribute a ' +
          'check to.',
        tags: ['Checklists'],
        params: blockKeyParam,
        body: { $ref: 'ChecklistItemCheckInput#' },
        response: {
          200: {
            description: 'The execution after recording this check',
            $ref: 'ChecklistExecution#'
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('You must be signed in to check off a checklist item.')
      }
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply
      }
      if (!mayOnPage(req, 'write:pages', req.params.siteId, page)) {
        return reply.forbidden('You are not allowed to check off items on this page.')
      }
      return CARDINAL.models.checklists.checkItem({
        siteId: req.params.siteId,
        pageId: page.id,
        blockKey: req.params.blockKey,
        itemKey: req.body.itemKey,
        itemCount: req.body.itemCount,
        userId: actor.id
      })
    }
  )
}

export default routes
