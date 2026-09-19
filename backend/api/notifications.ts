import { requireActorId } from '../helpers/pageAccess.ts'
import type { FastifyInstance } from 'fastify'

/**
 * No route-level `permissions`: every route answers only with the caller's own notifications,
 * scoped by session user id, so being logged in is the whole route-level check. `read:pages` is
 * re-verified at read time in `models/pageWatchEvents.ts#listForUser`, since it can be revoked
 * after a row is written.
 */

async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/notifications',
    {
      schema: {
        summary: "List the caller's unread notifications",
        description:
          'Every unread page-watch notification for the caller on this site, most recent change first. A notification disappears from this list once marked read — see PATCH on this same collection — the same way InboxReview lists only pending submissions.',
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Unread notifications',
            type: 'array',
            items: { $ref: 'Notification#' }
          }
        }
      }
    },
    async (req, reply) => {
      const userId = requireActorId(req, reply)
      if (!userId) {
        return reply
      }
      const rows = await CARDINAL.models.pageWatchEvents.listForUser(userId, req.params.siteId)

      // -> Caches the in-flight promise, not the resolved name: rows resolve concurrently, so two
      //    rows sharing an actor would otherwise both miss and both call `getById`.
      const actorNames = new Map<string, Promise<string>>()
      function resolveActorName(actorId: string | null): Promise<string> {
        if (!actorId) {
          return Promise.resolve('Someone')
        }
        let pending = actorNames.get(actorId)
        if (!pending) {
          pending = CARDINAL.models.users
            .getById(actorId)
            .then((actorUser: any) => actorUser?.name ?? 'Someone')
          actorNames.set(actorId, pending)
        }
        return pending
      }

      return Promise.all(
        rows.map(async (row) => ({
          ...row,
          actorName: await resolveActorName(row.actorId)
        }))
      )
    }
  )

  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/notifications/unread-count',
    {
      schema: {
        summary: "The caller's unread notification count",
        description:
          "A single number, for a badge that needs no page permission check and no page's worth of rows to answer.",
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Unread count',
            type: 'object',
            properties: {
              count: { type: 'integer' }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const userId = requireActorId(req, reply)
      if (!userId) {
        return reply
      }
      const count = await CARDINAL.models.pageWatchEvents.unreadCount(userId, req.params.siteId)
      return { count }
    }
  )

  app.patch<{ Params: { siteId: string; notificationId: string } }>(
    '/sites/:siteId/notifications/:notificationId/read',
    {
      schema: {
        summary: 'Mark one notification read',
        description:
          "Marking an already-read notification read again still answers 200 — the outcome asked for already holds, the same idempotency PUT/DELETE .../watch already give the rest of this feature. Answers 404 for a notification that does not exist or does not belong to the caller, so nobody can mark another user's row read by guessing its id.",
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            notificationId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'notificationId']
        },
        response: {
          200: {
            description: 'The notification is marked read',
            type: 'object',
            properties: {
              ok: { type: 'boolean' }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const userId = requireActorId(req, reply)
      if (!userId) {
        return reply
      }
      const found = await CARDINAL.models.pageWatchEvents.markRead(
        req.params.notificationId,
        userId
      )
      if (!found) {
        return reply.notFound('This notification does not exist.')
      }
      return { ok: true }
    }
  )
}

export default routes
