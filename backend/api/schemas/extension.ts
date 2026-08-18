import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * EXTENSION - Optional third-party tooling, with its state on this system
   */
  app.addSchema({
    $id: 'Extension',
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Directory name under `modules/extensions`.'
      },
      title: {
        type: 'string'
      },
      description: {
        type: 'string'
      },
      website: {
        type: 'string',
        description: 'Where the extension itself is documented. Empty when not declared.'
      },
      isInstalled: {
        type: 'boolean',
        description: 'Whether it was found on this system. Always false when incompatible.'
      },
      isInstallable: {
        type: 'boolean',
        description:
          'Whether the admin area can install it, rather than it being installed by hand.'
      },
      isCompatible: {
        type: 'boolean',
        description: 'Whether this platform and architecture can run it at all.'
      },
      incompatibleReason: {
        type: ['string', 'null'],
        description:
          'Why `isCompatible` is false — the architecture(s) and/or platform(s) this extension requires versus what this server reports. Null when compatible.'
      },
      needsRestart: {
        type: 'boolean',
        description:
          'True when this process already tried and failed to load the module — set independent of any install attempt this session, e.g. after a page render triggered the failure. Node replays a failed module load for the life of the process, so this stays true until the server restarts.'
      }
    }
  })
}
