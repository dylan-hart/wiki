import type { FastifyInstance, FastifyRequest } from 'fastify'
import { actorFromRequest } from '../../models/auditLog.ts'
import { actorFrom, mayOnPage } from '../../helpers/pageAccess.ts'

/**
 * Records a `page.classificationChanged` audit log entry (OpenProject #1081) -- called from every
 * site a page's classification actually changes: the PATCH route (an explicit set, raise or lower),
 * the move route (an auto-bump onto a stricter parent), and the classification-conflicts resolve
 * route (a bulk bump). A no-op when `from === to`, so a caller does not have to re-check that itself.
 *
 * Exported for `./write.ts`, which owns the PATCH and move routes — the two sites outside this file
 * that change a classification.
 */
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
  await WIKI.models.auditLog.record({
    event: 'page.classificationChanged',
    actor: actorFromRequest(req),
    targetType: 'page',
    targetId: page.id,
    targetLabel: page.path,
    detail: { from, to },
    siteId
  })
}

/**
 * Batched form of `recordClassificationChange`, for a caller that already knows every (from, to)
 * pair up front and wants one INSERT instead of N — the classification-conflicts resolve route
 * (OpenProject #1902), bumping many pages in one request. `from === to` entries are dropped rather
 * than written, the same no-op `recordClassificationChange` documents.
 */
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
  await WIKI.models.auditLog.recordMany(entries)
}

/**
 * Page classification: resolving the descendants a classification raise left below the new floor,
 * and the instance-wide report of what currently sits at each level.
 */
async function routes(app: FastifyInstance) {
  /**
   * RESOLVE CLASSIFICATION CONFLICTS
   *
   * The other half of the retroactive-parent-raise flow above: bumps the named descendants to a
   * classification an admin chose (typically the new parent floor `classificationConflicts` reported,
   * but not required to be — see the dialog's own doc comment for why leaving that open is deliberate).
   *
   * The dialog only ever asks for a raise, but this endpoint takes an arbitrary target level from the
   * request body and only gates it on `write:pages` — a caller is not the dialog, so both guarantees
   * `updatePage`'s own PATCH route enforces have to be checked here too, per page, rather than assumed:
   * the floor invariant against EACH target's own immediate parent (a bulk write does not get to skip
   * the check a single one would have to pass), and the declassification guardrail
   * (`manage:classification`) whenever the chosen level is actually more open than a given target's
   * current one. `bulkSetClassification` itself still does neither -- this is what makes that safe to
   * call afterwards.
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
      if (!WIKI.models.classificationLevels.byId(req.body.classification)) {
        return reply.badRequest('This classification level does not exist.')
      }
      // -> De-duplicate before processing: a repeated id would otherwise be fetched, permission-checked
      //    and audit-logged once per occurrence instead of once per page.
      const pageIds = [...new Set(req.body.pageIds)]
      // -> ONE batched select instead of a per-id `getPage` loop (OpenProject #1902): `getPage`'s
      //    full two-LEFT-JOIN select pulls `content`, `render`, `searchContent` and the tsvector,
      //    none of which `mayOnPage`/`meetsFloor` below need -- `getPagesByIds` projects only the
      //    five columns that do.
      const pageMap = await WIKI.models.pages.getPagesByIds(req.params.siteId, pageIds)
      const missingId = pageIds.find((pageId) => !pageMap.has(pageId))
      if (missingId) {
        return reply.notFound('One of these pages does not exist.')
      }
      // -> Preserves `pageIds`' own (de-duplicated) order exactly the way the original per-id loop
      //    iterated -- the per-page checks below still run one target at a time, in this same order,
      //    and bail on the same first violation. Only the READS moved: what each check evaluates is
      //    unchanged.
      const orderedTargets = pageIds.map((pageId) => pageMap.get(pageId)!)
      // -> ONE batched parent-classification lookup instead of one `parentClassification` call per
      //    target, over the distinct (locale, parent path) pairs among them.
      const floorByTarget = await WIKI.models.pageClassification.parentClassifications(
        req.params.siteId,
        orderedTargets.map((target) => ({ locale: target.locale, path: target.path }))
      )
      const targets: { id: string; path: string; classification: string }[] = []
      for (const target of orderedTargets) {
        if (!mayOnPage(req, 'write:pages', req.params.siteId, target)) {
          return reply.forbidden('You are not allowed to edit one of these pages.')
        }
        // -> Same declassification guardrail as the PATCH route: bringing a page UP needs nothing
        //    extra, but this endpoint is not restricted to raises the way the dialog that drives it
        //    is -- a caller asking for an actual lowering still needs manage:classification on it.
        if (
          WIKI.models.classificationLevels.isLowerThan(
            req.body.classification,
            target.classification
          ) &&
          !mayOnPage(req, 'manage:classification', req.params.siteId, target)
        ) {
          return reply.forbidden(
            'Lowering this page’s classification requires the manage:classification permission on it.'
          )
        }
        // -> Same floor invariant every other classification write enforces: this bulk write does
        //    not get to leave a page below its own immediate parent's floor just because it arrived
        //    through the resolve flow rather than a single PATCH.
        const floorId = floorByTarget.get(`${target.locale}\0${target.path}`) ?? null
        if (
          floorId &&
          !WIKI.models.classificationLevels.meetsFloor(req.body.classification, floorId)
        ) {
          return reply.badRequest(
            "A page's classification cannot be more open than its parent page's."
          )
        }
        targets.push(target)
      }
      const updated = await WIKI.models.pageClassification.bulkSetClassification(
        req.params.siteId,
        pageIds,
        req.body.classification
      )
      // -> ONE multi-row audit INSERT instead of one `record()` call per target.
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
   * CLASSIFICATION REPORT (OpenProject #1081)
   *
   * "Everything currently classified as X", instance-wide by default -- the coverage half of the
   * epic's auditability goal, alongside the `page.classificationChanged` events now feeding OpenProject
   * #989's audit log. `manage:system` only: this deliberately bypasses every page rule (it exists to
   * show an administrator what the rules are protecting, not to be gated by them), the same reasoning
   * `api/auditLog.ts` uses for its own listing.
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
      return WIKI.models.pageClassification.classificationReport(req.query.siteId)
    }
  )

  /**
   * CLASSIFICATION REPORT — DRILL DOWN (OpenProject #1081)
   */
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
      return WIKI.models.pageClassification.listByClassification(req.params.levelId, {
        siteId: req.query.siteId,
        limit: req.query.limit,
        offset: req.query.offset
      })
    }
  )
}

export default routes
