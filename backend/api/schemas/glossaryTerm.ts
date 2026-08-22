import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * GLOSSARY TERM INPUT - The writable fields, used for both create and update
   */
  app.addSchema({
    $id: 'GlossaryTermInput',
    type: 'object',
    properties: {
      term: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        description:
          'Matched case-insensitively and on whole words only against every page on this site.'
      },
      definition: {
        type: 'string',
        minLength: 1,
        description: 'Shown as the hover tooltip on every matched mention.'
      },
      pageId: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description: 'The term links through to this page when set. Null means no link.'
      }
    }
  })

  /**
   * GLOSSARY TERM - A stored term, as the admin screen lists it
   */
  app.addSchema({
    $id: 'GlossaryTerm',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      term: {
        type: 'string'
      },
      definition: {
        type: 'string'
      },
      pageId: {
        type: 'string',
        format: 'uuid',
        nullable: true
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      }
    }
  })

  /**
   * GLOSSARY RENDER TERM - The resolved shape the rendering pipeline matches against
   */
  app.addSchema({
    $id: 'GlossaryRenderTerm',
    type: 'object',
    properties: {
      term: {
        type: 'string'
      },
      definition: {
        type: 'string'
      },
      link: {
        type: 'string',
        nullable: true,
        description: "The term's canonical page, already resolved to a link. Null when none is set."
      }
    }
  })
}
