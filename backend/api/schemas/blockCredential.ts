import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * BLOCK CREDENTIAL
   *
   * Never carries a `secret` field — see `models/blockCredentials.ts`'s header comment. A block prop
   * (in a page's own markdown) references a credential by `id` alone.
   */
  app.addSchema({
    $id: 'BlockCredential',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      siteId: {
        type: 'string',
        format: 'uuid'
      },
      name: {
        type: 'string'
      },
      allowedDomains: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Domains (or `*.`-wildcard patterns) this credential's secret may be sent to. Empty means the credential cannot be used by any block."
      },
      createdAt: {
        type: 'string',
        format: 'date-time'
      },
      updatedAt: {
        type: 'string',
        format: 'date-time'
      }
    }
  })
}
