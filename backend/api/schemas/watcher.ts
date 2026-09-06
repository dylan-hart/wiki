import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * WATCHER - one person watching a page, as the page metadata rail plates them.
   *
   * Separate from `WatchedPage` (`api/schemas/page.ts`), which is the mirror image of this: that one
   * is a page seen from a watcher, this one is a watcher seen from a page. Neither shares a field
   * with the other beyond the fact that a `pageWatching` row is behind both.
   */
  app.addSchema({
    $id: 'Watcher',
    type: 'object',
    properties: {
      userId: { type: 'string', format: 'uuid' },
      name: {
        type: 'string',
        description:
          "The account's display name, as it would appear anywhere else in the interface."
      },
      initials: {
        type: 'string',
        description:
          'Up to two letters for a compact avatar plate — the first and last word of the name, or `?` for an account with no name on it. Served alongside `name` so a consumer that only draws plates does not have to re-derive them, and so every consumer draws the same two letters.'
      },
      watchedAt: {
        type: 'string',
        format: 'date-time',
        description: 'When this person started watching, which is what orders the list.'
      }
    }
  })

  /**
   * PAGE WATCHERS - the leading watchers of one page, and how many there are altogether.
   *
   * `total` counts every watcher, not the returned slice, which is what makes a `+N` remainder
   * possible without asking for the whole list.
   */
  app.addSchema({
    $id: 'PageWatchers',
    type: 'object',
    properties: {
      watchers: {
        type: 'array',
        description: "Oldest watcher first, capped at the request's `limit`.",
        items: { $ref: 'Watcher#' }
      },
      total: {
        type: 'integer',
        description:
          'How many people watch this page in total, ignoring `limit` — so a caller drawing three plates renders `total - 3` as the remainder.'
      }
    }
  })
}
