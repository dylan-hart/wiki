import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * BLOCK
   */
  app.addSchema({
    $id: 'Block',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      block: {
        type: 'string',
        description: 'Element suffix — the block renders as `<block-{block}>`.'
      },
      name: {
        type: 'string'
      },
      description: {
        type: 'string'
      },
      icon: {
        type: 'string',
        description: 'Blueprint icon name, resolved as `/_assets/icons/ultraviolet-{icon}.svg`.'
      },
      isEnabled: {
        type: 'boolean'
      },
      isCustom: {
        type: 'boolean',
        description: 'False for blocks registered from the compiled block manifest.'
      },
      // Deliberately loose: keyed by whatever attributes the block's own component declares (see
      // `props` below) — a different shape per block type, including custom blocks with no manifest.
      config: {
        type: 'object',
        additionalProperties: true,
        description:
          "This site's saved values for the block's `configFields`, keyed by field name — the data half, where `configFields` is the schema half (what fields exist, their types and defaults). Set by an admin via `PUT /sites/:siteId/blocks`, which sanitizes it against `configFields` on write. Empty for a block with no `configFields` to fill in, custom blocks included."
      },
      template: {
        type: 'string',
        description:
          'Body the editor writes between the opening and closing lines when inserting the block, for a block whose content is other blocks. Empty for a block that takes none.'
      },
      elementTag: {
        type: 'string',
        description: 'The custom element this block renders as — always `block-{block}`.'
      },
      props: {
        type: 'array',
        description:
          "The block's authorable attributes — what the editor's block picker turns into a form. For a built-in block, read from the compiled manifest, so it describes the code that is installed. For a custom block, read from what was uploaded.",
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Attribute name, as written on the element.'
            },
            type: {
              type: 'string',
              enum: ['string', 'number', 'boolean', 'select'],
              description: 'What kind of field to offer for it.'
            },
            label: {
              type: 'string'
            },
            hint: {
              type: 'string'
            },
            required: {
              type: 'boolean'
            },
            options: {
              type: 'array',
              description: 'Allowed values, for `select`.',
              items: { type: 'string' }
            },
            default: {
              description: 'Value the field starts on, and the one worth leaving out of the markup.'
            }
          }
        }
      },
      configFields: {
        type: 'array',
        description:
          "The block's site-level fields, as its component declares them — what the admin area's block config turns into a form. Set once per site by an admin, as opposed to `props`, which an author sets per use in the editor. Read from the compiled manifest rather than the database, so it describes the code that is installed. Empty for a custom block, which has no manifest entry.",
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Attribute name, as written on the element.'
            },
            type: {
              type: 'string',
              enum: ['string', 'number', 'boolean', 'select'],
              description: 'What kind of field to offer for it.'
            },
            label: {
              type: 'string'
            },
            hint: {
              type: 'string'
            },
            required: {
              type: 'boolean'
            },
            options: {
              type: 'array',
              description: 'Allowed values, for `select`.',
              items: { type: 'string' }
            },
            default: {
              description: 'Value the field starts on, and the one worth leaving out of the markup.'
            }
          }
        }
      }
    }
  })
}
