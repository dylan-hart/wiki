import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * GLOSSARY ALIAS - One alternate surface form of a term (OpenProject #2575)
   */
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
        items: { $ref: 'GlossaryAlias#' },
        default: [],
        description:
          'Alternate surface forms (acronyms, alternate names) matched the same way as `term`, all resolving to this same definition and canonical page.'
      },
      isAcronym: {
        type: 'boolean',
        // -> Deliberately NO `default` here, unlike `GlossaryAlias#isAcronym`/`GlossaryExportTerm#isAcronym`
        //    below -- this same schema also validates the single-term PUT body (OpenProject #870's
        //    "accepts any subset of the fields"), and `useDefaults` would otherwise inject `false`
        //    into every partial update that omits this field, silently clearing an existing acronym
        //    flag whenever a caller PUTs just `{ definition: '...' }`. Its absence stays `undefined`
        //    on the wire, which `models/glossary.ts#updateTerm`'s `input.isAcronym !== undefined`
        //    guard already treats as "leave it alone" -- `createTerm`'s `!!input.isAcronym` still
        //    coerces an omitted create-time value to `false` correctly, with no schema default needed.
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

  /**
   * GLOSSARY ACRONYM MAP - A lowercase-surface-form → canonical-display-casing lookup (OpenProject
   * #2575), consulted by the frontend's path-segment humanization helper.
   */
  app.addSchema({
    $id: 'GlossaryAcronymMap',
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Keys are lowercase surface forms; values are that surface form\'s canonical display casing, e.g. `{ "uss": "USS" }`.'
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
