import type { FastifyInstance, FastifyRequest } from 'fastify'
import { actorFromRequest } from '../../models/auditLog.ts'
import { actorFrom, mayOnPage } from '../../helpers/pageAccess.ts'

/** Every write that changes a page's classification records it here. A no-op when `from === to`. */
export async function recordClassificationChange(
  req: FastifyRequest,
  siteId: string,
  page: { id: string; path: string },
  from: string,
  to: string
): Promise<void> {
  if (from === to) {
    return
  }
  await CARDINAL.models.auditLog.record({
    event: 'page.classificationChanged',
    actor: actorFromRequest(req),
    targetType: 'page',
    targetId: page.id,
    targetLabel: page.path,
    detail: { from, to },
    siteId
  })
}

async function recordClassificationChanges(
  req: FastifyRequest,
  siteId: string,
  changes: { page: { id: string; path: string }; from: string; to: string }[]
): Promise<void> {
  const actor = actorFromRequest(req)
  const entries = changes
    .filter(({ from, to }) => from !== to)
    .map(({ page, from, to }) => ({
      event: 'page.classificationChanged' as const,
      actor,
      targetType: 'page' as const,
      targetId: page.id,
      targetLabel: page.path,
      detail: { from, to },
      siteId
    }))
  await CARDINAL.models.auditLog.recordMany(entries)
}

async function routes(app: FastifyInstance) {
  /**
   * The dialog driving this only ever asks for a raise, but the endpoint takes an arbitrary level
   * from any `write:pages` caller. So both guarantees the PATCH route enforces are checked here per
   * page: the floor against each target's immediate parent, and `manage:classification` for a
   * lowering. `bulkSetClassification` checks neither itself.
   */
  app.post<{
    Params: { siteId: string }
    Body: { pageIds: string[]; classification: string }
  }>(
    '/sites/:siteId/pages/classification-conflicts/resolve',
    {
      // -> No route-level permissions: page-rule permissions, checked per page below.
      schema: {
        summary: 'Bump a set of pages to a classification level',
        description:
          "Resolves the descendants a classification-resolution-dialog conflict listed, by setting each to the chosen level. Every id must belong to this site and the caller must hold write:pages on each; lowering one below its current level also needs manage:classification on it, the same declassification guardrail the PATCH route enforces. The chosen level may never leave a page below its own immediate parent's floor.",
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['pageIds', 'classification'],
          properties: {
            pageIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
              minItems: 1,
              maxItems: 500
            },
            classification: { type: 'string', format: 'uuid' }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, updated: { type: 'integer' } }
          },
          400: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Resolving a classification conflict requires a logged in user.')
      }
      if (!CARDINAL.models.classificationLevels.byId(req.body.classification)) {
        return reply.badRequest('This classification level does not exist.')
      }
      // -> De-duplicated: a repeated id would otherwise be audit-logged once per occurrence.
      const pageIds = [...new Set(req.body.pageIds)]
      const pageMap = await CARDINAL.models.pages.getPagesByIds(req.params.siteId, pageIds)
      const missingId = pageIds.find((pageId) => !pageMap.has(pageId))
      if (missingId) {
        return reply.notFound('One of these pages does not exist.')
      }
      const orderedTargets = pageIds.map((pageId) => pageMap.get(pageId)!)
      const floorByTarget = await CARDINAL.models.pageClassification.parentClassifications(
        req.params.siteId,
        orderedTargets.map((target) => ({ locale: target.locale, path: target.path }))
      )
      const targets: { id: string; path: string; classification: string }[] = []
      for (const target of orderedTargets) {
        if (!mayOnPage(req, 'write:pages', req.params.siteId, target)) {
          return reply.forbidden('You are not allowed to edit one of these pages.')
        }
        if (
          CARDINAL.models.classificationLevels.isLowerThan(
            req.body.classification,
            target.classification
          ) &&
          !mayOnPage(req, 'manage:classification', req.params.siteId, target)
        ) {
          return reply.forbidden(
            'Lowering this page’s classification requires the manage:classification permission on it.'
          )
        }
        const floorId = floorByTarget.get(`${target.locale}\0${target.path}`) ?? null
        if (
          floorId &&
          !CARDINAL.models.classificationLevels.meetsFloor(req.body.classification, floorId)
        ) {
          return reply.badRequest(
            "A page's classification cannot be more open than its parent page's."
          )
        }
        targets.push(target)
      }
      const updated = await CARDINAL.models.pageClassification.bulkSetClassification(
        req.params.siteId,
        pageIds,
        req.body.classification
      )
      await recordClassificationChanges(
        req,
        req.params.siteId,
        targets.map((target) => ({
          page: target,
          from: target.classification,
          to: req.body.classification
        }))
      )
      return { ok: true, updated }
    }
  )

  /**
   * `manage:system` only: the report bypasses every page rule on purpose. It shows an administrator
   * what the rules protect, so it cannot be gated by them.
   */
  app.get<{ Querystring: { siteId?: string } }>(
    '/pages/classification-report',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'How many pages currently carry each classification level',
        description:
          'Every configured level is included, even at zero, in level order. Instance-wide unless siteId narrows it to one site.',
        tags: ['Pages'],
        querystring: {
          type: 'object',
          properties: { siteId: { type: 'string', format: 'uuid' } }
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                levelId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                sortOrder: { type: 'integer' },
                count: { type: 'integer' }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.pageClassification.classificationReport(req.query.siteId)
    }
  )

  app.get<{
    Params: { levelId: string }
    Querystring: { siteId?: string; limit?: number; offset?: number }
  }>(
    '/pages/classification-report/:levelId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List every page currently at one classification level',
        description: 'Paginated, newest-updated first. Instance-wide unless siteId narrows it.',
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: { levelId: { type: 'string', format: 'uuid' } },
          required: ['levelId']
        },
        querystring: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    path: { type: 'string' },
                    locale: { type: 'string' },
                    title: { type: 'string' },
                    siteId: { type: 'string', format: 'uuid' }
                  }
                }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.pageClassification.listByClassification(req.params.levelId, {
        siteId: req.query.siteId,
        limit: req.query.limit,
        offset: req.query.offset
      })
    }
  )
}

export default routes
