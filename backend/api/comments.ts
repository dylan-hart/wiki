import type { FastifyInstance } from 'fastify'
import type { AccessActor } from '../models/groups.ts'
import type { AdminPageRef } from '../models/comments.ts'

/**
 * Comments API Routes
 *
 * Task 617 (Feature 394): which comment provider is active for a site, and what it is configured
 * with. Task 625 (this file's other half, added below): a site-wide comment moderation
 * listing/deletion surface, scoped to whichever pages the requesting actor holds `manage:comments`
 * on. The page-scoped comment CRUD routes (`GET/POST/PATCH/DELETE .../pages/:pageId/comments`) are
 * Feature 391's own task, built independently on a sibling branch (`feature/comments-rest-api`) not
 * yet merged into this one — inspected read-only for this task, per this run's cross-branch rules,
 * but not reused. When that branch lands, its routes join this file rather than living in a second
 * one; see the provenance note on the `comments` table in `db/schema.ts` and the doc comment on
 * `models/comments.ts` for exactly what is expected to reconcile at that point (this file adds no
 * page-scoped list/create/update/delete of its own — only the admin-wide listing and a
 * moderation-only delete, neither of which exists on `feature/comments-rest-api` either).
 */
const siteIdParam = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId']
}

const commentIdParam = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    commentId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId', 'commentId']
}

/**
 * QUERY STRATEGY (Task 625): the accessible-pages set behind the admin moderation listing.
 *
 * `manage:comments` is a page-rule permission (`helpers/pageRules.ts`), not a global one, so this
 * route cannot ask "may this actor moderate comments on this site?" as a single yes/no the way
 * `config.permissions` would — it has to be decided per page, individually, exactly as `api/pages.ts`
 * and `api/assets.ts` already do for their own page-rule permissions (the `No route-level
 * permissions:` pattern this route follows below).
 *
 * The naive version of "per page, individually" is a per-COMMENT check: fetch every comment on the
 * site, then call `checkAccess` once per row before deciding whether to keep it. That is an N+1
 * shaped cost against exactly the table this endpoint is built to page through — the more comments a
 * site has, the slower every single request gets, independent of how many the actor can actually see.
 *
 * This does the opposite: it bounds the permission check by page COUNT, not comment count.
 * `WIKI.models.groups.checkAccess` is a synchronous, in-memory call — `models/groups.ts` keeps every
 * group's rules cached, reloaded on write, so evaluating it repeatedly costs no database round trip at
 * all — so the only DB-bound work is one query for the site's page refs (`comments.pageRefsForSite`,
 * `pages_siteId_idx`, narrowed further by a `pathFilter` prefix match pushed into the query itself)
 * plus the `manage:comments` evaluation against each row, all in memory. The result — a `Set` of
 * accessible page ids, typically a small fraction of a site's total comment volume — is what actually
 * reaches `comments.listForAdmin`, which does the real pagination (`LIMIT`/`OFFSET` in SQL) against
 * `comments_siteId_idx (siteId, createdAt)` narrowed by `pageId IN (...)`. No comment row is ever
 * fetched, let alone permission-checked, unless it belongs to a page already known to be accessible.
 *
 * `manage:system` short-circuits entirely, matching `checkAccess` itself: every page is accessible,
 * so the per-page evaluation is skipped rather than trivially answering `true` for each one.
 */
async function accessiblePageIdsForAdmin(
  actor: AccessActor,
  siteId: string,
  pathFilter?: string
): Promise<string[]> {
  const pageRefs: AdminPageRef[] = await WIKI.models.comments.pageRefsForSite(siteId, pathFilter)
  if (actor.permissions.includes('manage:system')) {
    return pageRefs.map((page) => page.id)
  }
  return pageRefs
    .filter((page) => WIKI.models.groups.checkAccess(actor, 'manage:comments', page))
    .map((page) => page.id)
}

async function routes(app: FastifyInstance) {
  /**
   * LIST A SITE'S COMMENT PROVIDERS
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/comments/providers',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: "List a site's comment providers",
        description:
          'One entry per comments module installed in `modules/comments`, whether or not it has ever been enabled — same pattern as `GET /sites/:siteId/storage/targets`. At most one entry has `isEnabled` true: comments have a single active provider per site, not several simultaneous targets.',
        tags: ['Comments'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId']
        },
        response: {
          200: {
            description: 'List of comment providers',
            type: 'array',
            items: { $ref: 'CommentProvider#' }
          }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      return WIKI.models.commentProviders.getSiteProviders(req.params.siteId)
    }
  )

  /**
   * SET THE ACTIVE COMMENT PROVIDER
   */
  app.put<{ Params: { siteId: string }; Body: { module: string; config?: Record<string, any> } }>(
    '/sites/:siteId/comments/providers',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: "Set a site's active comment provider",
        description:
          'Activates the named module and stores its config values, disabling whichever provider was active before. There is exactly one active provider per site at any time; there is no endpoint to turn comments off short of activating a module and leaving its config at defaults, since "no provider active" is not itself a supported state past initial site creation.',
        tags: ['Comments'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId']
        },
        body: { $ref: 'CommentProviderInput#' },
        response: {
          200: {
            description: 'The provider now active, as stored',
            $ref: 'CommentProvider#'
          }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      try {
        const provider = await WIKI.models.commentProviders.setActiveProvider(
          req.params.siteId,
          req.body.module,
          req.body.config ?? {}
        )
        if (!provider) {
          return reply.notFound(`No such comment provider module: ${req.body.module}`)
        }
        return provider
      } catch (err: any) {
        return reply.badRequest(err.message)
      }
    }
  )

  /**
   * LIST COMMENTS ACROSS A SITE FOR MODERATION
   */
  app.get<{
    Params: { siteId: string }
    Querystring: {
      pagePath?: string
      author?: string
      dateFrom?: string
      dateTo?: string
      offset?: number
      limit?: number
    }
  }>(
    '/sites/:siteId/comments',
    {
      /*
        No route-level `permissions`: `manage:comments` is a page-rule permission, granted by a
        group's rules and not the group-wide list that hook checks — same pattern as `api/pages.ts`,
        `api/assets.ts` and `api/watching.ts`. Every comment below is included only after its own
        page individually passes `checkAccess(actor, 'manage:comments', page)` — see
        `accessiblePageIdsForAdmin` above for how that is done without an N+1 per-comment check.
      */
      schema: {
        summary: 'List comments across a site for moderation',
        description:
          'Every comment on every page the requesting actor holds `manage:comments` on, across the whole site — distinct from `GET .../pages/:pageId/comments` (Feature 391), which is scoped to one page and needs only `read:comments`. Nothing here is granted by a single site-wide flag: a comment is included only after the page it lives on individually passes a `manage:comments` check, so two administrators with different rules see different, correctly scoped lists from the same request shape.\n\nPaginated (`offset`/`limit`, `totalHits` ignores both) and filterable by page path (prefix match), author (substring match against the account name or guest name), and a `createdAt` date range.',
        tags: ['Comments'],
        params: siteIdParam,
        querystring: {
          type: 'object',
          properties: {
            pagePath: {
              type: 'string',
              maxLength: 2048,
              description: 'Only comments on pages whose path starts with this.'
            },
            author: {
              type: 'string',
              maxLength: 255,
              description: 'Substring match against the account name or guest name.'
            },
            dateFrom: {
              type: 'string',
              format: 'date-time',
              description: 'Only comments created at or after this instant.'
            },
            dateTo: {
              type: 'string',
              format: 'date-time',
              description: 'Only comments created at or before this instant.'
            },
            offset: {
              type: 'integer',
              minimum: 0,
              default: 0
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 25
            }
          }
        },
        response: {
          200: {
            description: 'Matching comments, plus how many there are in total',
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: { $ref: 'AdminComment#' }
              },
              totalHits: {
                type: 'integer',
                description: 'How many comments match, ignoring `limit` and `offset`.'
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }

      const actor = WIKI.models.groups.actorForRequest(req)
      const pageIds = await accessiblePageIdsForAdmin(actor, req.params.siteId, req.query.pagePath)

      return WIKI.models.comments.listForAdmin({
        siteId: req.params.siteId,
        pageIds,
        author: req.query.author,
        dateFrom: req.query.dateFrom ? new Date(req.query.dateFrom) : undefined,
        dateTo: req.query.dateTo ? new Date(req.query.dateTo) : undefined,
        offset: req.query.offset,
        limit: req.query.limit
      })
    }
  )

  /**
   * DELETE A COMMENT (MODERATION)
   */
  app.delete<{ Params: { siteId: string; commentId: string } }>(
    '/sites/:siteId/comments/:commentId',
    {
      /*
        No route-level `permissions`: same reasoning as the listing above. `manage:comments` is
        checked against this one comment's own page below, individually — never assumed from the
        site-wide listing having been reachable at all.
      */
      schema: {
        summary: 'Delete a comment (moderation)',
        description:
          "Deletes any comment on the site, provided the requesting actor holds `manage:comments` on the page it lives on. Distinct from Feature 391's page-scoped delete, which additionally lets a comment's own author remove it without that permission — this endpoint carries no such exception, since it exists purely for moderation.",
        tags: ['Comments'],
        params: commentIdParam,
        response: {
          204: {
            description: 'The comment was deleted',
            type: 'null'
          }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }

      const comment = await WIKI.models.comments.getWithPage(req.params.commentId)
      // -> Existence is checked only after confirming it belongs to this site, so a comment id from a
      //    different site is indistinguishable from one that does not exist at all.
      if (!comment || comment.siteId !== req.params.siteId) {
        return reply.notFound('This comment does not exist.')
      }

      const actor = WIKI.models.groups.actorForRequest(req)
      if (!WIKI.models.groups.checkAccess(actor, 'manage:comments', comment.page)) {
        return reply.forbidden('You are not allowed to moderate comments on this page.')
      }

      await WIKI.models.comments.delete(comment.id)
      return reply.code(204).send()
    }
  )
}

export default routes
