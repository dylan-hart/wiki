import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * COMMENT PROVIDER - A comments module as configured for a site
   */
  app.addSchema({
    $id: 'CommentProvider',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      module: {
        type: 'string',
        description: 'Directory name under `modules/comments`.'
      },
      isEnabled: {
        type: 'boolean',
        description: 'Whether this is the site’s active provider. At most one is ever true.'
      },
      title: {
        type: 'string'
      },
      description: {
        type: 'string'
      },
      icon: {
        type: 'string'
      },
      vendor: {
        type: 'string'
      },
      website: {
        type: 'string'
      },
      isAvailable: {
        type: 'boolean'
      },
      props: {
        type: 'object',
        additionalProperties: true,
        description:
          'The module configuration, declared in its `definition.yml`: each entry carries a `type`, `title`, `hint`, `default` and the display hints the admin area renders a control from. A `readOnly` prop is shown but cannot be changed, and is silently kept at its stored value when written to.'
      },
      config: {
        type: 'object',
        additionalProperties: true,
        description:
          'Values for the module props, completed with the module defaults for any prop that has none stored yet.'
      }
    }
  })

  /**
   * COMMENT PROVIDER INPUT - Which provider becomes active, and its config values
   */
  app.addSchema({
    $id: 'CommentProviderInput',
    type: 'object',
    required: ['module'],
    properties: {
      module: {
        type: 'string',
        description: 'Directory name under `modules/comments` of the provider to activate.'
      },
      config: {
        type: 'object',
        additionalProperties: true,
        description:
          'Values for the module props. Validated against what the module declares: an unknown key is dropped, a wrong type is refused, and a read-only prop keeps its stored value.'
      }
    }
  })
}
