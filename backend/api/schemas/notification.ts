import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * NOTIFICATION - One unread page-watch event, as the in-app inbox lists it (task 535)
   *
   * Backed by `pageWatchEvents` (see that table's own doc comment) rather than a separate table: a row
   * there already IS "a notification owed to one watcher about one change," and `readAt` is a second,
   * independent column alongside the pre-existing `deliveredAt` — see `db/schema.ts` for why the two
   * must not be conflated. This schema only ever describes an UNREAD row (`GET .../notifications`
   * excludes read ones outright, matching how `InboxReview` lists only pending submissions), so there
   * is no `readAt` field here to be confusingly always-null.
   */
  app.addSchema({
    $id: 'Notification',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      pageId: { type: 'string', format: 'uuid' },
      pageTitle: {
        type: 'string',
        description:
          'The page title as of the change, captured at write time — see `pageWatchEvents`.'
      },
      pagePath: { type: 'string' },
      action: {
        type: 'string',
        enum: ['updated', 'moved', 'deleted'],
        description:
          'What kind of change this notification is about. Never `created` — see `notifyWatchers`.'
      },
      changedFields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Which fields the change touched. Empty for a move or a delete.'
      },
      actorId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'Who made the change, or null if that account has since been deleted.'
      },
      actorName: {
        type: 'string',
        description:
          'The actor\'s display name, resolved from `actorId` — "Someone" if there is none.'
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'When the change this notification is about happened.'
      }
    }
  })
}
