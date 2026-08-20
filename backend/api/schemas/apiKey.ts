import type { FastifyInstance } from 'fastify'
import { KEY_EXPIRATIONS } from '../../models/apiKeys.ts'
import { ALL_PERMISSIONS } from '../../helpers/permissions.ts'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * API KEY SCOPE PERMISSION - The closed vocabulary a scope entry may name
   */
  app.addSchema({
    $id: 'ApiKeyScopePermission',
    type: 'string',
    enum: ALL_PERMISSIONS
  })

  /**
   * API KEY - Metadata only; the token itself exists once, in the create response
   */
  app.addSchema({
    $id: 'ApiKey',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      name: {
        type: 'string'
      },
      keyShort: {
        type: 'string',
        description: 'Last characters of the token, to tell keys apart. The token is not stored.'
      },
      groups: {
        type: 'array',
        description: 'IDs of the groups this key draws its permissions from.',
        items: {
          type: 'string',
          format: 'uuid'
        }
      },
      scope: {
        type: ['array', 'null'],
        description:
          'An explicit permission allow-list the key is narrowed to, or null for no narrowing at all — the key then carries the full union of its groups. Can only narrow, never grant beyond what the groups already hold.',
        items: { $ref: 'ApiKeyScopePermission#' }
      },
      siteId: {
        type: ['string', 'null'],
        format: 'uuid',
        description:
          'The single site this key is pinned to, or null for instance-wide (every site).'
      },
      userId: {
        type: ['string', 'null'],
        format: 'uuid',
        description:
          "The user this is a personal access token for, or null for an admin-issued key. A personal token always carries exactly this user's own current permissions, resolved live — never the `groups` above."
      },
      expiration: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      },
      isRevoked: {
        type: 'boolean'
      },
      isInvalidated: {
        type: 'boolean',
        description:
          "Issued before the signing certificates were last regenerated, so its signature no longer verifies. Not a state anybody set — it is the key's age against the keypair's, and unlike revocation it applies to every key at once."
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
   * API KEY EXPIRATION - The lifetimes a new key can be given
   */
  app.addSchema({
    $id: 'ApiKeyExpiration',
    type: 'string',
    enum: Object.keys(KEY_EXPIRATIONS)
  })
}
