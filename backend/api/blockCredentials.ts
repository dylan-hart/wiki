import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * Whether this caller may create, rotate or delete this site's block credentials.
 *
 * Same gate `api/blocks.ts#mayManageBlocks` uses: `manage:sites`, or the narrower `site:blocks`
 * delegation. Credential management lives beside block administration rather than behind a
 * permission of its own — a group trusted to decide which blocks a site runs is the same group
 * trusted to decide which endpoints those blocks may authenticate to.
 */
function mayManageCredentials(req: FastifyRequest, siteId: string): boolean {
  const actor = WIKI.models.groups.actorForRequest(req)
  return (
    actor.permissions.includes('manage:sites') ||
    WIKI.models.groups.checkSiteAccess(actor, 'site:blocks', siteId)
  )
}

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
      // `helpers/siteRules.ts`), which the group-wide hook cannot check — see `mayManageCredentials`.
      schema: {
        summary: "List a site's block credentials",
        description:
          'Names and ids only — never the secret. Requires `manage:sites`, or `site:blocks` on this site.',
        tags: ['Blocks'],
        params: {
          type: 'object',
          properties: { siteId: { type: 'string', format: 'uuid' } },
          required: ['siteId']
        },
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
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      if (!mayManageCredentials(req, req.params.siteId)) {
        return reply.forbidden()
      }
      return WIKI.models.blockCredentials.getSiteCredentials(req.params.siteId)
    }
  )

  /**
   * CREATE A BLOCK CREDENTIAL
   */
  app.post<{ Params: { siteId: string }; Body: { name: string; secret: string } }>(
    '/sites/:siteId/block-credentials',
    {
      schema: {
        summary: 'Create a block credential',
        description:
          'The secret is written once, here — it is never returned by this or any other route again. Requires `manage:sites`, or `site:blocks` on this site.',
        tags: ['Blocks'],
        params: {
          type: 'object',
          properties: { siteId: { type: 'string', format: 'uuid' } },
          required: ['siteId']
        },
        body: {
          type: 'object',
          required: ['name', 'secret'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            secret: {
              type: 'string',
              minLength: 1,
              description:
                'The bearer token / API key a block-live-data instance authenticates with.'
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
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      if (!mayManageCredentials(req, req.params.siteId)) {
        return reply.forbidden()
      }
      return WIKI.models.blockCredentials.createCredential(
        req.params.siteId,
        req.body.name,
        req.body.secret
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
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      if (!mayManageCredentials(req, req.params.siteId)) {
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
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      if (!mayManageCredentials(req, req.params.siteId)) {
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
