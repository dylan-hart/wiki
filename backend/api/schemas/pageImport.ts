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
        description: 'GitHub-flavored Markdown, as pandoc converted it. Not yet saved anywhere.'
      }
    }
  })
}
