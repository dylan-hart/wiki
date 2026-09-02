import { requireActorId } from '../helpers/pageAccess.ts'
import type { FastifyInstance } from 'fastify'

/**
 * In-App Notification Inbox API Routes (task 535)
 *
 * The 'in-app optionally' half of page-watch notifications: what `models/pageWatchEvents.ts` already
 * records for every watcher of every change (see that model's and `db/schema.ts`'s own comments) is
 * readable here regardless of whether mail delivery ever succeeds, or is even configured — every row
 * a watcher is owed is written before any send is attempted (`models/pages.ts#notifyWatchers`), so the
 * in-app inbox never depends on it.
 *
 * No route-level `permissions`: every route here answers only with the caller's OWN notifications,
 * scoped by session `userId` — same shape as `GET /sites/:siteId/watching` in `watching.ts`. Being
 * logged in is the whole of the check at the route level; the page permission itself IS re-verified,
 * just one layer down, in `models/pageWatchEvents.ts#listForUser` (OpenProject #2173) — a row being
 * written for someone who could read the page at watch time is not good enough on its own, since
 * revoking `read:pages` afterwards (a raised classification, a move into a restricted branch, an
 * edited group rule) is an ordinary lifecycle event, not something that waits for this list to be
 * asked again. See that method's own comment for how a page since deleted (where there is no longer a
 * live row to check permissions against) is handled.
 */

async function routes(app: FastifyInstance) {
  /**
   * LIST UNREAD NOTIFICATIONS
   */
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
      const rows = await WIKI.models.pageWatchEvents.listForUser(userId, req.params.siteId)

      // -> Resolved once per distinct actor in this page of results, not once per row: several
      //    notifications very plausibly share the same actor (see the identical pattern and reasoning
      //    in `tasks/simple/send-watch-digests.ts#resolveActorName`). The cache holds the in-flight
      //    PROMISE, not the resolved name — rows are resolved concurrently below via `Promise.all`, so
      //    caching only the settled value would let two rows for the same actor both miss the cache
      //    and both call `getById` before either had a chance to populate it.
      const actorNames = new Map<string, Promise<string>>()
      function resolveActorName(actorId: string | null): Promise<string> {
        if (!actorId) {
          return Promise.resolve('Someone')
        }
        let pending = actorNames.get(actorId)
        if (!pending) {
          pending = WIKI.models.users
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

  /**
   * UNREAD NOTIFICATION COUNT
   */
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
      const count = await WIKI.models.pageWatchEvents.unreadCount(userId, req.params.siteId)
      return { count }
    }
  )

  /**
   * MARK A NOTIFICATION READ
   */
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
      const found = await WIKI.models.pageWatchEvents.markRead(req.params.notificationId, userId)
      if (!found) {
        return reply.notFound('This notification does not exist.')
      }
      return { ok: true }
    }
  )
}

export default routes
