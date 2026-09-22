import type { FastifyInstance } from 'fastify'
import { TEMPLATE_EDITORS } from '../../models/pageTemplates.ts'

const templateProperties = {
  name: {
    type: 'string',
    minLength: 1,
    maxLength: 255,
    description: 'Unique within its site and locale, ignoring case.'
  },
  description: {
    type: 'string',
    maxLength: 1000,
    description: 'Shown beside the name when an author picks a template.'
  },
  editor: {
    type: 'string',
    enum: [...TEMPLATE_EDITORS],
    description: 'The editor the starter content is written for. `markdown` when absent.'
  },
  locale: {
    type: 'string',
    minLength: 1,
    maxLength: 255,
    nullable: true,
    description: 'The one locale this template is offered for. Null or absent means every locale.'
  },
  content: {
    type: 'string',
    description:
      "The starter source, in whatever the editor writes. Sanitized against the saving author's `write:scripts` and `write:styles` before it is stored, so what comes back may differ from what was sent."
  }
}

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'PageTemplateInput',
    type: 'object',
    required: ['name'],
    properties: templateProperties
  })

  app.addSchema({
    $id: 'PageTemplatePatch',
    type: 'object',
    properties: templateProperties
  })

  app.addSchema({
    $id: 'PageTemplate',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      locale: { type: 'string', nullable: true },
      name: { type: 'string' },
      description: { type: 'string' },
      editor: { type: 'string' },
      content: { type: 'string' },
      createdBy: { type: 'string', format: 'uuid', nullable: true },
      createdAt: { type: 'string', format: 'date-time', description: 'RFC 3339 Date Time' },
      updatedAt: { type: 'string', format: 'date-time', description: 'RFC 3339 Date Time' }
    }
  })
}
