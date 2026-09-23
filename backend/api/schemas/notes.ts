import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'NoteSection',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
      position: { type: 'integer', description: 'Where the section sits, counting from 0.' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  })

  app.addSchema({
    $id: 'NoteSummary',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      sectionId: { type: 'string', format: 'uuid' },
      title: {
        type: ['string', 'null'],
        description: 'Null for an untitled note, which is listed by its `excerpt` instead.'
      },
      excerpt: {
        type: 'string',
        description: "The first non-empty line of the note's content, without markdown."
      },
      position: {
        type: 'integer',
        description: 'Where the note sits in its section, counting from 0.'
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  })

  app.addSchema({
    $id: 'Note',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      sectionId: { type: 'string', format: 'uuid' },
      title: { type: ['string', 'null'] },
      excerpt: { type: 'string' },
      content: {
        type: 'string',
        description: 'The markdown the WYSIWYG editor saves, the same format a page stores.'
      },
      position: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  })

  app.addSchema({
    $id: 'NoteImageUpload',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      url: {
        type: 'string',
        description:
          'Always `/_api/sites/<siteId>/notes/<noteId>/images/<imageId>`. Put this in the note content; promoting the note rewrites it.'
      }
    }
  })

  app.addSchema({
    $id: 'NoteSearchResults',
    type: 'object',
    properties: {
      results: {
        type: 'array',
        description: 'Best match first.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            sectionId: { type: 'string', format: 'uuid' },
            title: { type: ['string', 'null'] },
            excerpt: { type: 'string' }
          }
        }
      }
    }
  })
}
