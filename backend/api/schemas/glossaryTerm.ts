import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'GlossaryAlias',
    type: 'object',
    required: ['value'],
    properties: {
      value: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        description:
          'Matched case-insensitively and on whole words only, same as `term` -- resolves to the same definition and canonical page.'
      },
      isAcronym: {
        type: 'boolean',
        default: false,
        description:
          'Marks this alias\'s stored casing (e.g. "USS") as a canonical DISPLAY casing, distinct from an ordinary alias -- consulted by the path-segment humanizer via a lowercase lookup key.'
      }
    }
  })

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
        items: { $ref: 'GlossaryAlias#' },
        default: [],
        description:
          'Alternate surface forms (acronyms, alternate names) matched the same way as `term`, all resolving to this same definition and canonical page.'
      },
      isAcronym: {
        type: 'boolean',
        // -> No `default`, unlike `GlossaryAlias#isAcronym`: this schema also validates the partial
        //    PUT body, where `useDefaults` would inject `false` and silently clear an existing flag.
        description:
          "Marks the TERM ITSELF (as opposed to one of its aliases) as an acronym -- same canonical-display-casing meaning as an alias's own `isAcronym`. Omit to leave unchanged on an update; treated as `false` on create."
      },
      pageId: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description: 'The term links through to this page when set. Null means no link.'
      }
    }
  })

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
        items: { $ref: 'GlossaryAlias#' }
      },
      isAcronym: {
        type: 'boolean'
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
        items: { $ref: 'GlossaryAlias#' }
      },
      isAcronym: {
        type: 'boolean'
      },
      link: {
        type: 'string',
        nullable: true,
        description: "The term's canonical page, already resolved to a link. Null when none is set."
      }
    }
  })

  app.addSchema({
    $id: 'GlossaryAcronymMap',
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Keys are lowercase surface forms; values are that surface form\'s canonical display casing, e.g. `{ "uss": "USS" }`.'
  })

  /**
   * Carries `path`, not `pageId`: an id is meaningless once this JSON is re-imported, possibly into
   * a different instance. Stored version snapshots use this shape too.
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
        items: { $ref: 'GlossaryAlias#' },
        default: []
      },
      isAcronym: {
        type: 'boolean',
        default: false
      },
      path: {
        type: 'string',
        nullable: true,
        description:
          "The canonical page's path, resolved against the site's primary locale. Null when unset."
      }
    }
  })

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

  app.addSchema({
    $id: 'GlossarySaveResult',
    type: 'object',
    properties: {
      terms: { type: 'array', items: { $ref: 'GlossaryTerm#' } },
      version: { $ref: 'GlossaryVersionSummary#' }
    }
  })
}
