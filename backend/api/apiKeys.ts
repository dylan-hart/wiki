import { issueKey, validateApiKeyInput } from '../models/apiKeys.ts'
import { actorFromRequest } from '../models/auditLog.ts'
import type { FastifyInstance } from 'fastify'
import type { KeyExpiration } from '../models/apiKeys.ts'

/**
 * API Keys Routes
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST API KEYS
   */
  app.get(
    '/',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List all API keys',
        description:
          'Revoked and expired keys are listed too, so that the admin area can show their state.',
        tags: ['API Keys'],
        response: {
          200: {
            description: 'List of API keys',
            type: 'array',
            items: { $ref: 'ApiKey#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return WIKI.models.apiKeys.getKeys()
    }
  )

  /**
   * CREATE API KEY
   */
  app.post<{
    Body: {
      name: string
      expiration: KeyExpiration
      groups: string[]
      scope?: string[] | null
      allowedClassifications?: string[] | null
      siteId?: string | null
    }
  }>(
    '/',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Create a new API key',
        description:
          'The response carries the token, which is the only time it can be read: only its last characters are stored. The key holds the combined permissions of the groups given, narrowed to `scope` when one is given.',
        tags: ['API Keys'],
        body: {
          type: 'object',
          required: ['name', 'expiration', 'groups'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              description: 'What the key is for.'
            },
            expiration: { $ref: 'ApiKeyExpiration#' },
            groups: {
              type: 'array',
              minItems: 1,
              description:
                'Groups whose permissions the key carries. The guests group is not accepted.',
              items: {
                type: 'string',
                format: 'uuid'
              }
            },
            scope: {
              type: ['array', 'null'],
              default: null,
              description:
                'An explicit permission allow-list to narrow the key to. Omit or pass null for no narrowing — the key then carries the full union of the groups given. Can only narrow: a permission here that none of the groups grant still grants nothing.',
              items: { $ref: 'ApiKeyScopePermission#' }
            },
            allowedClassifications: {
              type: ['array', 'null'],
              default: null,
              description:
                "A per-level classification allow-set (OpenProject #1205): the key may never be granted a page permission on a page whose classification is not in this list. Omit or pass null for unrestricted (every level, including one added later) — today's only behavior, and the default.",
              items: {
                type: 'string',
                format: 'uuid'
              }
            },
            siteId: {
              type: ['string', 'null'],
              format: 'uuid',
              default: null,
              description:
                'The single site to pin the key to — every /sites/:siteId route rejects a request this key makes against any other site — or null for instance-wide (every site), which stays the default.'
            }
          }
        },
        response: {
          200: {
            description: 'API key created successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              id: {
                type: 'string',
                format: 'uuid'
              },
              key: {
                type: 'string',
                description: 'The token. Shown once and never again.'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      // -> Bearer-token callers never mint keys, admin-issued or personal: `manage:system` on a key
      //    stands in for a session at the route-permission hook (`index.ts`), but none of `groups`,
      //    `scope`, `allowedClassifications` or `siteId` below is intersected against the calling
      //    key's own restrictions, so a site-pinned, classification-restricted PAT could otherwise
      //    mint itself an unrestricted key with a full expiry term. Session-only, matching what
      //    `api/users/profile.ts`'s `sessionUserId()` already enforces for the self-service PAT routes.
      if (req.apiKey) {
        return reply.forbidden('API keys cannot be created using another API key.')
      }
      // -> The `siteId` this validates is a body field pinning the KEY BEING CREATED, not the
      //    caller's own site -- no `enforceApiKeySite()` call; this route is `manage:system`-only,
      //    see `helpers/apiKeySite.ts`'s doc comment for why that rules it out.
      const invalid = validateApiKeyInput(req.body, 'Key')
      if (invalid) {
        return reply.badRequest(invalid)
      }

      // -> A key inherits group permissions, so every group must exist; a stale client should not
      //    silently mint a key with fewer permissions than the operator picked
      if (await WIKI.models.groups.hasUnknownGroupIds(req.body.groups)) {
        return reply.badRequest('One of the groups does not exist.')
      }
      // -> Guests are anonymous visitors: a key holding their permissions grants nothing a caller
      //    could not already do without one
      if (req.body.groups.includes(WIKI.data.systemIds.guestsGroupId)) {
        return reply.badRequest('The guests group cannot be used for API keys.')
      }

      const { id, key } = await issueKey(
        {
          name: req.body.name,
          expiration: req.body.expiration,
          groups: req.body.groups,
          scope: req.body.scope ?? null,
          allowedClassifications: req.body.allowedClassifications ?? null,
          siteId: req.body.siteId ?? null
        },
        {
          actor: actorFromRequest(req),
          detail: { groups: req.body.groups, siteId: req.body.siteId ?? null }
        }
      )

      return {
        ok: true,
        message: 'API key created successfully.',
        id,
        key
      }
    }
  )

  /**
   * REVOKE API KEY
   */
  app.post<{ Params: { keyId: string } }>(
    '/:keyId/revoke',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Revoke an API key',
        description:
          'Permanent: the key stays listed as revoked and stops authenticating on the next request. Revoking never deletes, so the record of what existed is kept — `POST /system/api-keys/purge` is what discards those rows, when an administrator asks for it.',
        tags: ['API Keys'],
        params: {
          type: 'object',
          properties: {
            keyId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['keyId']
        },
        response: {
          200: {
            description: 'API key revoked successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#', description: 'The key is already revoked.' }
        }
      }
    },
    async (req, reply) => {
      // -> Same rule as creation above: a bearer-token caller cannot revoke a key, including itself.
      if (req.apiKey) {
        return reply.forbidden('API keys cannot be revoked using another API key.')
      }
      const key = await WIKI.models.apiKeys.getKeyById(req.params.keyId)
      if (!key) {
        return reply.notFound('API key does not exist.')
      }
      if (key.isRevoked) {
        return reply.conflict('This API key is already revoked.')
      }

      await WIKI.models.apiKeys.revokeKey(key.id)
      await WIKI.models.auditLog.record({
        event: 'apiKey.revoked',
        actor: actorFromRequest(req),
        targetType: 'apiKey',
        targetId: key.id,
        targetLabel: key.name
      })

      return {
        ok: true,
        message: 'API key revoked successfully.'
      }
    }
  )
}

export default routes
