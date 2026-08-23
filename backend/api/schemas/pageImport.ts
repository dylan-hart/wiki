import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * PAGE IMPORT RESULT - A file converted to Markdown, ready for the markdown editor
   */
  app.addSchema({
    $id: 'PageImportResult',
    type: 'object',
    properties: {
      ok: {
        type: 'boolean'
      },
      message: {
        type: 'string'
      },
      markdown: {
        type: 'string',
        description:
          "GitHub-flavored Markdown — pandoc's conversion for every format except `markdown`, whose bytes are passed through unchanged. Not yet saved anywhere."
      },
      title: {
        type: 'string',
        description:
          "Only set for `format: 'markdown'` when the file had a leading YAML front-matter block naming one (OpenProject #1092)."
      },
      description: {
        type: 'string',
        description: 'Same front-matter source as `title`.'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Same front-matter source as `title`.'
      }
    }
  })

  /**
   * PAGE IMPORT BATCH ITEM - One file's result within a batch import, same shape as a single
   * PageImportResult plus which file it was — the array has no other way to say that back.
   */
  app.addSchema({
    $id: 'PageImportBatchItem',
    type: 'object',
    properties: {
      fileName: {
        type: 'string',
        description: 'The uploaded file name this result belongs to, in the order it was sent.'
      },
      ok: {
        type: 'boolean'
      },
      message: {
        type: 'string'
      },
      markdown: {
        type: 'string',
        description:
          "GitHub-flavored Markdown — pandoc's conversion for every format except `markdown`, whose bytes are passed through unchanged. Not yet saved anywhere."
      },
      title: {
        type: 'string',
        description:
          "Only set for `format: 'markdown'` when the file had a leading YAML front-matter block naming one (OpenProject #1092)."
      },
      description: {
        type: 'string',
        description: 'Same front-matter source as `title`.'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Same front-matter source as `title`.'
      }
    }
  })
}
