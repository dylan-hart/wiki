import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'NotePromoteParams',
    type: 'object',
    properties: {
      siteId: { type: 'string', format: 'uuid' },
      noteId: { type: 'string', format: 'uuid' }
    },
    required: ['siteId', 'noteId']
  })

  app.addSchema({
    $id: 'NotePromoteInput',
    type: 'object',
    additionalProperties: false,
    required: ['path', 'title'],
    properties: {
      path: {
        type: 'string',
        minLength: 1,
        maxLength: 2048,
        description: 'Where the new page goes, the same way a page create names it.'
      },
      title: { type: 'string', minLength: 1, maxLength: 255 },
      locale: {
        type: 'string',
        minLength: 1,
        maxLength: 10,
        description: "The site's primary locale when absent."
      },
      render: {
        type: 'string',
        description:
          "The HTML the client rendered from the note's content, with the note's own image URLs still in it. Absent, the server queues a render instead."
      },
      noteUpdatedAt: {
        type: 'string',
        format: 'date-time',
        description:
          'The `updatedAt` of the note version `render` was made from. Required with `render`; a note saved since answers 409 `noteChanged`.'
      }
    }
  })

  app.addSchema({
    $id: 'NotePromoteResult',
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      pageId: { type: 'string', format: 'uuid' },
      path: { type: 'string' },
      locale: { type: 'string' },
      images: {
        type: 'integer',
        description: 'How many of the note images were re-homed as assets beside the new page.'
      }
    }
  })
}
