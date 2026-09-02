import type { FastifyInstance } from 'fastify'
import { ORIGIN_PATTERN_SOURCE } from '../helpers/network.ts'
import { maySiteAdmin } from '../helpers/siteRules.ts'

/*
  Credential management is gated by the same `manage:sites` / `site:blocks` pair `api/blocks.ts`'s own
  routes use, not a permission of its own — a group trusted to decide which blocks a site runs is the
  same group trusted to decide which endpoints those blocks may authenticate to. See
  `models/groups.ts#checkSiteAdminAccess` for why the global half is site-blind.
*/

/**
 * Block Credentials API Routes (OpenProject #868)
 *
 * A per-site store for secrets a server-fetching block (`block-live-data`) needs but must never hold
 * itself — a block prop lives in a page's own markdown, readable by anyone with `read:source`. See
 * `models/blockCredentials.ts`'s header comment for the full design. Every response here is the
 * `BlockCredential` shape, which has no `secret` field — the secret is written once, at creation or
 * rotation, and never read back through this API again.
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST SITE BLOCK CREDENTIALS
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/block-credentials',
    {
      // No route-level `permissions`: gated by `site:blocks` (a site-scoped rule, see
      // `helpers/siteRules.ts`), which the group-wide hook cannot check — see `checkSiteAdminAccess`.
      schema: {
        summary: "List a site's block credentials",
        description:
          'Names and ids only — never the secret. Requires `manage:sites`, or `site:blocks` on this site.',
        tags: ['Blocks'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'List of block credentials',
            type: 'array',
            items: { $ref: 'BlockCredential#' }
          },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!maySiteAdmin(req, 'manage:sites', 'site:blocks', req.params.siteId)) {
        return reply.forbidden()
      }
      return WIKI.models.blockCredentials.getSiteCredentials(req.params.siteId)
    }
  )

  /**
   * CREATE A BLOCK CREDENTIAL
   */
  app.post<{
    Params: { siteId: string }
    Body: { name: string; secret: string; allowedOrigins: string[] }
  }>(
    '/sites/:siteId/block-credentials',
    {
      schema: {
        summary: 'Create a block credential',
        description:
          'The secret is written once, here — it is never returned by this or any other route again. `allowedOrigins` must name at least one origin: an empty list would mean the credential can never actually be used (see `models/liveData.ts`), which is never a state worth creating on purpose. Requires `manage:sites`, or `site:blocks` on this site.',
        tags: ['Blocks'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['name', 'secret', 'allowedOrigins'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            secret: {
              type: 'string',
              minLength: 1,
              description:
                'The bearer token / API key a block-live-data instance authenticates with.'
            },
            allowedOrigins: {
              type: 'array',
              items: { type: 'string', minLength: 1, pattern: ORIGIN_PATTERN_SOURCE },
              minItems: 1,
              description:
                "Origins (scheme + host[:port], optionally `*.`-wildcarded) plus an optional path prefix -- e.g. `https://api.example.com/v1` -- this credential's secret may be sent to. At least one is required."
            }
          }
        },
        response: {
          200: { description: 'Block credential created', $ref: 'BlockCredential#' },
          400: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!maySiteAdmin(req, 'manage:sites', 'site:blocks', req.params.siteId)) {
        return reply.forbidden()
      }
      return WIKI.models.blockCredentials.createCredential(
        req.params.siteId,
        req.body.name,
        req.body.secret,
        req.body.allowedOrigins
      )
    }
  )

  /**
   * ROTATE A BLOCK CREDENTIAL'S SECRET
   */
  app.post<{ Params: { siteId: string; credentialId: string }; Body: { secret: string } }>(
    '/sites/:siteId/block-credentials/:credentialId/rotate',
    {
      schema: {
        summary: "Rotate a block credential's secret",
        description:
          "Replaces the stored secret, keeping the credential's id and name — every block prop still pointing at this id picks up the new secret on its next fetch, with nothing to edit in page content. Requires `manage:sites`, or `site:blocks` on this site.",
        tags: ['Blocks'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            credentialId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'credentialId']
        },
        body: {
          type: 'object',
          required: ['secret'],
          properties: { secret: { type: 'string', minLength: 1 } }
        },
        response: {
          200: {
            description: 'Secret rotated successfully',
            type: 'object',
            properties: { ok: { type: 'boolean' }, message: { type: 'string' } }
          },
          400: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!maySiteAdmin(req, 'manage:sites', 'site:blocks', req.params.siteId)) {
        return reply.forbidden()
      }
      const rotated = await WIKI.models.blockCredentials.rotateSecret(
        req.params.siteId,
        req.params.credentialId,
        req.body.secret
      )
      if (!rotated) {
        return reply.notFound('Credential does not exist.')
      }
      return { ok: true, message: 'Secret rotated successfully.' }
    }
  )

  /**
   * UPDATE A BLOCK CREDENTIAL'S ALLOWED ORIGINS
   */
  app.post<{
    Params: { siteId: string; credentialId: string }
    Body: { allowedOrigins: string[] }
  }>(
    '/sites/:siteId/block-credentials/:credentialId/allowed-origins',
    {
      schema: {
        summary: "Replace a block credential's allowed origins",
        description:
          'Unlike creation, this may be set to an empty list — an admin deliberately disabling the credential rather than deleting it, which is safe: `models/liveData.ts` refuses every url for a credential with no allowed origins. Requires `manage:sites`, or `site:blocks` on this site.',
        tags: ['Blocks'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            credentialId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'credentialId']
        },
        body: {
          type: 'object',
          required: ['allowedOrigins'],
          properties: {
            allowedOrigins: {
              type: 'array',
              items: { type: 'string', minLength: 1, pattern: ORIGIN_PATTERN_SOURCE },
              description:
                "Origins (scheme + host[:port], optionally `*.`-wildcarded) plus an optional path prefix -- e.g. `https://api.example.com/v1` -- this credential's secret may be sent to. May be empty."
            }
          }
        },
        response: {
          200: {
            description: 'Allowed origins updated successfully',
            type: 'object',
            properties: { ok: { type: 'boolean' }, message: { type: 'string' } }
          },
          400: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!maySiteAdmin(req, 'manage:sites', 'site:blocks', req.params.siteId)) {
        return reply.forbidden()
      }
      const updated = await WIKI.models.blockCredentials.updateAllowedOrigins(
        req.params.siteId,
        req.params.credentialId,
        req.body.allowedOrigins
      )
      if (!updated) {
        return reply.notFound('Credential does not exist.')
      }
      return { ok: true, message: 'Allowed origins updated successfully.' }
    }
  )

  /**
   * DELETE A BLOCK CREDENTIAL
   */
  app.delete<{ Params: { siteId: string; credentialId: string } }>(
    '/sites/:siteId/block-credentials/:credentialId',
    {
      schema: {
        summary: 'Delete a block credential',
        description:
          'Any block prop still pointing at this id fails to resolve afterwards — this does not touch page content. Requires `manage:sites`, or `site:blocks` on this site.',
        tags: ['Blocks'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            credentialId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'credentialId']
        },
        response: {
          204: { description: 'Credential deleted successfully' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!maySiteAdmin(req, 'manage:sites', 'site:blocks', req.params.siteId)) {
        return reply.forbidden()
      }
      const deleted = await WIKI.models.blockCredentials.deleteCredential(
        req.params.siteId,
        req.params.credentialId
      )
      if (!deleted) {
        return reply.notFound('Credential does not exist.')
      }
      return reply.code(204).send()
    }
  )
}

export default routes
