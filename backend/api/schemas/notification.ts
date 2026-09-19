import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * Only ever describes an unread `pageWatchEvents` row -- the listing excludes read ones -- so
   * there is no always-null `readAt` field.
   */
  app.addSchema({
    $id: 'Notification',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      pageId: {
        type: ['string', 'null'],
        format: 'uuid',
        description:
          'Null once the page this notification is about has since been deleted (OpenProject #3203) — `pagePath`/`pageLocale` below are what survives that and are what a link is built from.'
      },
      pageTitle: {
        type: 'string',
        description:
          'The page title as of the change, captured at write time — see `pageWatchEvents`.'
      },
      pagePath: { type: 'string' },
      pageLocale: {
        type: 'string',
        description:
          'The page locale as of the change, captured at write time — see `pageWatchEvents`. Used to build a locale-prefixed link to the page.'
      },
      action: {
        type: 'string',
        enum: ['updated', 'moved', 'deleted'],
        description:
          'What kind of change this notification is about. Never `created` — see `notifyWatchers`.'
      },
      changedFields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Which fields the change touched. Up to `path`/`locale`/`title` for a move, empty for a delete.'
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
