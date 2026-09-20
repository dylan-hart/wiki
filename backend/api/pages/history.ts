import type { FastifyInstance } from 'fastify'
import {
  actorFrom,
  mayOnPage,
  mayReadSource,
  requireReadablePage
} from '../../helpers/pageAccess.ts'

async function routes(app: FastifyInstance) {
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
      return CARDINAL.models.pageHistory.list(req.params.siteId, req.params.pageId, {
        limit: req.query.limit,
        cursor: req.query.cursor
      })
    }
  )

  app.get<{ Params: { siteId: string; pageId: string; versionId: string } }>(
    '/sites/:siteId/pages/:pageId/history/:versionId',
    {
      // -> No route-level `permissions`: `read:history` is a page permission, checked against this
      //    page in the handler
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
      const version = await CARDINAL.models.pageHistory.getVersion(
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

  app.get<{ Params: { siteId: string }; Querystring: { limit?: number; cursor?: string } }>(
    '/sites/:siteId/pages/deleted',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and `read:history` is a
        page permission granted by a rule. Checked per row below instead, against the path, locale,
        tags and classification each deletion happened at.
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
      const { items, nextCursor } = await CARDINAL.models.pageHistory.listRecoverable(
        req.params.siteId,
        {
          limit: req.query.limit,
          cursor: req.query.cursor
        }
      )
      // -> Built once per request: `mayOnPage()` would rebuild it for every row
      const actor = CARDINAL.models.groups.actorForRequest(req)
      return {
        items: items.filter((row) =>
          CARDINAL.models.groups.checkAccess(actor, 'read:history', {
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

  app.post<{
    Params: { siteId: string; versionId: string }
    Body: { path?: string; locale?: string }
  }>(
    '/sites/:siteId/pages/deleted/:versionId/recover',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and these are page
        permissions granted by a rule. The handler checks two refs: the SOURCE the version was
        deleted from must be readable, and the TARGET (the override, else the source) writable.
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
      const version = await CARDINAL.models.pageHistory.getDeletedVersion(
        req.params.siteId,
        req.params.versionId
      )
      if (!version) {
        return reply.notFound('No deleted version exists with this id.')
      }
      // -> `write:pages` on the target says nothing about reading what the version contains, and
      //    recovery republishes its source. Checked against the version's OWN tags/classification:
      //    that is where the content being read lived.
      const source = {
        path: version.path,
        locale: version.locale,
        tags: version.tags,
        classification: version.classification
      }
      if (
        !mayOnPage(req, 'read:pages', req.params.siteId, source) ||
        !mayReadSource(req, req.params.siteId, source)
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
      const page = await CARDINAL.models.pageHistory.recoverDeletedPage(
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
