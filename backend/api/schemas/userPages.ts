import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'UserPageEntry',
    type: 'object',
    properties: {
      pageId: { type: 'string', format: 'uuid' },
      path: { type: 'string' },
      locale: { type: 'string' },
      title: { type: 'string' },
      description: { type: ['string', 'null'] },
      icon: { type: ['string', 'null'] },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'When the page last changed.'
      },
      kind: { type: 'string', enum: ['recent', 'favorite', 'pinned'] },
      position: {
        type: ['integer', 'null'],
        description: 'Where a pin sits in the list, counting from 0. Null for anything but a pin.'
      },
      touchedAt: {
        type: 'string',
        format: 'date-time',
        description:
          'When the caller last visited the page for a recent, or when they favorited or pinned it.'
      }
    }
  })

  app.addSchema({
    $id: 'UserPagesList',
    type: 'object',
    properties: {
      recent: {
        type: 'array',
        description: 'Most recently visited first, capped server-side.',
        items: { $ref: 'UserPageEntry#' }
      },
      favorites: {
        type: 'array',
        description: 'Most recently favorited first.',
        items: { $ref: 'UserPageEntry#' }
      },
      pinned: {
        type: 'array',
        description: 'In the order they were pinned.',
        items: { $ref: 'UserPageEntry#' }
      }
    }
  })
}
