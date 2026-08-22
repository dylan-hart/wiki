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
      aliases: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 255 },
        default: [],
        description:
          'Alternate surface forms (acronyms, alternate names) matched the same way as `term`, all resolving to this same definition and canonical page -- no per-alias override.'
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
      aliases: {
        type: 'array',
        items: { type: 'string' }
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
      aliases: {
        type: 'array',
        items: { type: 'string' }
      },
      link: {
        type: 'string',
        nullable: true,
        description: "The term's canonical page, already resolved to a link. Null when none is set."
      }
    }
  })

  /**
   * GLOSSARY EXPORT TERM - The portable, external-editing-round-trip shape (OpenProject #1114):
   * carries `path`, not `pageId`, since an id is meaningless once this JSON is edited outside the app
   * and re-imported, possibly into a different instance. Shared as-is by export, import, and each
   * stored version snapshot (OpenProject #1113).
   */
  app.addSchema({
    $id: 'GlossaryExportTerm',
    type: 'object',
    required: ['term', 'definition'],
    properties: {
      term: { type: 'string' },
      definition: { type: 'string' },
      aliases: {
        type: 'array',
        items: { type: 'string' },
        default: []
      },
      path: {
        type: 'string',
        nullable: true,
        description:
          "The canonical page's path, resolved against the site's primary locale. Null when unset."
      }
    }
  })

  /**
   * GLOSSARY EXPORT - The whole-glossary JSON round-trip shape, and an import request body.
   */
  app.addSchema({
    $id: 'GlossaryExport',
    type: 'object',
    required: ['terms'],
    properties: {
      formatVersion: { type: 'integer' },
      terms: {
        type: 'array',
        items: { $ref: 'GlossaryExportTerm#' }
      }
    }
  })

  /**
   * GLOSSARY VERSION SUMMARY - One saved snapshot's metadata, without the snapshot itself
   * (OpenProject #1113)
   */
  app.addSchema({
    $id: 'GlossaryVersionSummary',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      termCount: { type: 'integer' },
      actorId: { type: 'string', format: 'uuid', nullable: true },
      actorName: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time', description: 'RFC 3339 Date Time' }
    }
  })

  /**
   * GLOSSARY VERSION - A saved snapshot, including its full term list
   */
  app.addSchema({
    $id: 'GlossaryVersion',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      termCount: { type: 'integer' },
      actorId: { type: 'string', format: 'uuid', nullable: true },
      actorName: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time', description: 'RFC 3339 Date Time' },
      snapshot: { $ref: 'GlossaryExport#' }
    }
  })

  /**
   * GLOSSARY SAVE RESULT - The live term list as it now stands, plus the version it was just saved as
   */
  app.addSchema({
    $id: 'GlossarySaveResult',
    type: 'object',
    properties: {
      terms: { type: 'array', items: { $ref: 'GlossaryTerm#' } },
      version: { $ref: 'GlossaryVersionSummary#' }
    }
  })
}
