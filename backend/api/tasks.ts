import type { FastifyInstance } from 'fastify'
import { actorFrom, splitList, unlockedFor } from '../helpers/pageAccess.ts'

async function routes(app: FastifyInstance) {
  app.get<{
    Params: { siteId: string }
    Querystring: { tag?: string; folder?: string; offset?: number; limit?: number }
  }>(
    '/sites/:siteId/tasks',
    {
      schema: {
        summary: 'List the unchecked task items across a site',
        description:
          'Every unchecked `- [ ]` item on every page the caller may read, grouped by page and ordered by path. A password-protected page the caller has not unlocked contributes nothing, and neither does a page they may not read. Each item carries the `index` the tick route (`PUT /sites/:siteId/pages/:pageId/tasks/:index`) takes, and each page its `updatedAt` for that route’s `expectedUpdatedAt`.\n\nPaginated by page (`offset`/`limit`; `totalHits` and `totalItems` ignore both) and filterable by tag and folder.',
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            tag: {
              type: 'string',
              maxLength: 2048,
              description: 'Tags a page must carry, all of them (comma-separated).'
            },
            folder: {
              type: 'string',
              maxLength: 2048,
              description: 'Only pages at this path or beneath it.'
            },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
          }
        },
        response: {
          200: { $ref: 'TaskRollup#' }
        }
      }
    },
    async (req) => {
      const { siteId } = req.params
      return CARDINAL.models.tasks.listOpenTasks({
        siteId,
        actor: CARDINAL.models.groups.actorForRequest(req),
        isUnlocked: (page) => unlockedFor(req, siteId, page),
        publicOnly: !actorFrom(req),
        tags: splitList(req.query.tag),
        folder: req.query.folder,
        offset: req.query.offset,
        limit: req.query.limit
      })
    }
  )
}

export default routes
