import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'AiProvider',
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Directory name under `modules/ai`.'
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
      logo: {
        type: 'string'
      },
      vendor: {
        type: 'string'
      },
      website: {
        type: 'string'
      },
      props: {
        type: 'object',
        additionalProperties: true,
        description:
          'The provider configuration, declared in its `definition.yml`: each entry carries a `type`, `title`, `hint`, `default` and the display hints the admin area renders a control from. A `sensitive` prop (the API key) is masked on every read; sending the mask back leaves the stored value untouched. A `required` prop must resolve to a non-empty value to select this provider.'
      },
      hasImplementation: {
        type: 'boolean',
        description: 'Whether an `ai.ts` sits next to the definition.'
      },
      isSelected: {
        type: 'boolean',
        description: "Whether this is the site's currently active AI provider."
      },
      config: {
        type: 'object',
        additionalProperties: true,
        description:
          'Values for the provider props, completed with the provider defaults for any prop that has none stored yet, with every `sensitive` value masked. Kept even for a provider that is not currently selected, so switching back to it does not lose what was entered.'
      }
    }
  })
}
