import type { FastifyInstance } from 'fastify'
import { actorFrom, mayOnPage, requireReadablePage } from '../../helpers/pageAccess.ts'

/**
 * A page's past: its version history, and the deletions still recoverable from it.
 */
async function routes(app: FastifyInstance) {
  /**
   * PAGE HISTORY
   */
  app.get<{
    Params: { siteId: string; pageId: string }
    Querystring: { limit?: number; cursor?: string }
  }>(
    '/sites/:siteId/pages/:pageId/history',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and `read:history` is a
        page permission granted by a rule. Checked against this page below instead.
      */
      schema: {
        summary: "Get a page's version history",
        description:
          "One page of recorded versions of the page, newest first — the first entry of the first page is the page as it stands now.\n\nKeyset-paginated on `versionDate` rather than offset-based, so a deep history stays cheap to page through: pass the previous response's `nextCursor` back as `cursor` to fetch the next page, and stop once `nextCursor` comes back null. Needs `read:history` ON THIS PAGE, granted by a group rule — the permission that says who may see what a page used to contain. Reading the page itself is required on top, so a page the caller could not open answers 404 and a password-protected one answers only once the session has satisfied `POST …/unlock`.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        querystring: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 200,
              default: 50,
              description: 'Versions per page.'
            },
            cursor: {
              type: 'string',
              description:
                "Opaque cursor from a previous response's `nextCursor`, to fetch the next page."
            }
          }
        },
        response: {
          200: { $ref: 'PageHistoryList#' },
          400: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        permission: 'read:history',
        forbiddenMessage: "You are not allowed to read this page's history."
      })
      if (!page) {
        return reply
      }
      return WIKI.models.pageHistory.list(req.params.siteId, req.params.pageId, {
        limit: req.query.limit,
        cursor: req.query.cursor
      })
    }
  )

  /**
   * PAGE HISTORY VERSION
   */
  app.get<{ Params: { siteId: string; pageId: string; versionId: string } }>(
    '/sites/:siteId/pages/:pageId/history/:versionId',
    {
      // -> Checked per page below, for the same reason as the history list above
      schema: {
        summary: 'Get a single version of a page',
        description:
          'One version in full, source included — one side of a comparison. Needs `read:history` and the ability to read the page, on the same terms as the history list.',
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            pageId: {
              type: 'string',
              format: 'uuid'
            },
            versionId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId', 'pageId', 'versionId']
        },
        response: {
          200: { $ref: 'PageHistoryVersion#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        permission: 'read:history',
        forbiddenMessage: "You are not allowed to read this page's history."
      })
      if (!page) {
        return reply
      }
      const version = await WIKI.models.pageHistory.getVersion(
        req.params.siteId,
        req.params.pageId,
        req.params.versionId
      )
      if (!version) {
        return reply.notFound('This version does not exist.')
      }
      return version
    }
  )

  /**
   * DELETED PAGES (RECOVERABLE)
   */
  app.get<{ Params: { siteId: string }; Querystring: { limit?: number; cursor?: string } }>(
    '/sites/:siteId/pages/deleted',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and `read:history` is a
        page permission granted by a rule. Checked per row below instead, against the path, locale,
        tags and classification each deletion happened at — a caller sees only the deletions they
        could have read the history of; the rest are left out rather than answered as a whole-list
        403. `author.email` is never populated on these rows: `read:history` here is granted per row
        by whatever the caller could read, not `read:users`/`manage:users`, so it must not double as
        a way to learn another user's address.
      */
      schema: {
        summary: 'List recoverable deletions',
        description:
          'One row per deleted path still recoverable: the most recent `deleted` version at a path with no live page there now. A path that was recovered, or reused by an unrelated new page, drops off this list on its own — there is no flag to set or clear.\n\nEach row needs `read:history` at the path and locale it was deleted from, using the tags and classification the deleted version itself carried — so a TAG/TAGALL/CLASSIFICATION-scoped rule narrows this listing the same way it would a live page — granted by a group rule. Rows the caller may not read are dropped from `items` after each page is fetched, which can make `items` shorter than `limit` even mid-list; only `nextCursor` says whether more remain, so keep paging while it is non-null regardless of how many rows came back on any one page.',
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 200,
              default: 50,
              description: 'Rows to scan per page, before the per-row permission filter is applied.'
            },
            cursor: {
              type: 'string',
              description: 'Opaque `nextCursor` from a previous page. Omit for the first page.'
            }
          }
        },
        response: {
          200: { $ref: 'PageHistoryRecoverablePage#' }
        }
      }
    },
    async (req) => {
      const { items, nextCursor } = await WIKI.models.pageHistory.listRecoverable(
        req.params.siteId,
        {
          limit: req.query.limit,
          cursor: req.query.cursor
        }
      )
      // -> Built once per request rather than once per row -- `mayOnPage()` rebuilds it internally
      //    on every call. See `graph.ts`'s graph route and `tree.ts`'s `visibleTreeItems()` for the
      //    same shape.
      const actor = WIKI.models.groups.actorForRequest(req)
      return {
        items: items.filter((row) =>
          WIKI.models.groups.checkAccess(actor, 'read:history', {
            path: row.path,
            locale: row.locale,
            tags: row.tags,
            classification: row.classification,
            siteId: req.params.siteId
          })
        ),
        nextCursor
      }
    }
  )

  /**
   * RECOVER DELETED PAGE
   */
  app.post<{
    Params: { siteId: string; versionId: string }
    Body: { path?: string; locale?: string }
  }>(
    '/sites/:siteId/pages/deleted/:versionId/recover',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and `write:pages`/
        `read:pages`/`read:source` are page permissions granted by a rule. Checked in the handler
        against TWO refs: the SOURCE path/locale the version was deleted from (must be readable, since
        `recoverDeletedPage` rebuilds title, content, tags, relations and scripts from it) and the
        TARGET path/locale — the override when given, otherwise the same source path/locale — which
        must be writable.
      */
      schema: {
        summary: 'Recover a deleted page',
        description:
          'Recreates the page from one specific deleted version, found by its history id rather than "the latest deletion at this path" — so a caller acting on a `GET …/pages/deleted` row recovers exactly the version it showed.\n\nRequires `read:pages` and `read:source` at the path the version was deleted from — the version is rebuilding title, content, tags, relations and scripts, so recovering it must not hand those back to someone who could not have read them there — and `write:pages` at the target path (the override below, or the same deleted path when none is given).\n\n`path` and/or `locale` in the body steer the recreated page around a conflict the plain restore would hit: a path a newer page has since taken answers `pageDuplicatePath` (409), and a locale the site no longer serves answers `pageInvalidLocale` (400) — both as the same JSON error shape every other page-creation failure uses, not a generic 500.',
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            versionId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId', 'versionId']
        },
        body: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              maxLength: 255,
              pattern: '^/?[a-zA-Z0-9-_/]*$',
              description: 'Recreate at this path instead of the one the page was deleted from.'
            },
            locale: {
              type: 'string',
              minLength: 1,
              maxLength: 10,
              description: 'Recreate in this locale instead of the one the page was deleted from.'
            }
          }
        },
        response: {
          200: { $ref: 'PageHistoryRecoverResponse#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Recovering a page requires a logged in user.')
      }
      const version = await WIKI.models.pageHistory.getDeletedVersion(
        req.params.siteId,
        req.params.versionId
      )
      if (!version) {
        return reply.notFound('No deleted version exists with this id.')
      }
      // -> OpenProject #2168: a source-side check, ahead of the destination one below. Holding
      //    `write:pages` on where the page is going back to says nothing about being allowed to read
      //    what it actually contained -- without this, a caller who was denied `read:pages`/
      //    `read:source` at the path it was deleted from could still recover it into anywhere they
      //    hold `write:pages`, reading and republishing source they were never allowed to read.
      //    Checked against the version's OWN tags/classification, not the target's: what is being
      //    read here is the deleted content itself, at the path/locale it actually lived at.
      const source = {
        path: version.path,
        locale: version.locale,
        tags: version.tags,
        classification: version.classification
      }
      if (
        !mayOnPage(req, 'read:pages', req.params.siteId, source) ||
        !mayOnPage(req, 'read:source', req.params.siteId, source)
      ) {
        return reply.forbidden(
          'You are not allowed to read the page this version was deleted from.'
        )
      }
      const overrides = req.body ?? {}
      const target = {
        path: overrides.path ?? version.path,
        locale: overrides.locale ?? version.locale
      }
      if (!mayOnPage(req, 'write:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to recover a page here.')
      }
      const page = await WIKI.models.pageHistory.recoverDeletedPage(
        req.params.siteId,
        req.params.versionId,
        actor,
        overrides
      )
      return {
        ok: true,
        message: 'Page recovered successfully.',
        page
      }
    }
  )
}

export default routes
