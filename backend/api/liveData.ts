import type { FastifyInstance } from 'fastify'
import type { LiveDataRequest } from '../models/liveData.ts'

/**
 * No route-level `permissions` and no per-page read check: this answers with a block's resolved
 * data, never the page, and stays open to anonymous readers for a credential-free request.
 *
 * A `credentialId` is not a secret — it is a declared block prop, so it survives into the stored
 * HTML of every page embedding the block. An anonymous caller who learned one could otherwise drive
 * an authenticated proxy request to anywhere the credential's allowlist permits, so the handler
 * refuses it without a session or API key.
 */
async function routes(app: FastifyInstance) {
  app.post<{ Params: { siteId: string }; Body: LiveDataRequest }>(
    '/sites/:siteId/live-data/resolve',
    {
      schema: {
        summary: "Resolve a block-live-data instance's value",
        description:
          "Fetches the given URL server-side — with the stored credential's secret as a bearer token, when `credentialId` is given — and extracts one value from the JSON response by JSONPath. Cached per site/credential/url/jsonPath for the given `refreshInterval` (clamped to 10s–24h), so several readers with the same block open share one upstream request. Fresh (cache-miss) fetches are rate-limited independent of that cache, per credential (or per site for a credential-free request) — see `models/liveData.ts`. `credentialId` requires an authenticated caller (a session or an API key); a credential-free request needs neither. Gated by the site's `live-data` block toggle, same as every other block.",
        tags: ['Blocks'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['url', 'jsonPath'],
          properties: {
            credentialId: { type: 'string', format: 'uuid', nullable: true },
            url: {
              type: 'string',
              maxLength: 2048,
              description: 'The REST/JSON endpoint to poll.'
            },
            jsonPath: {
              type: 'string',
              maxLength: 512,
              description:
                'JSONPath expression naming the one field to show. May not be a bare "$" (the whole response).'
            },
            refreshInterval: {
              type: 'number',
              description: 'Seconds between fetches. Clamped to 10–86400; defaults to 60.'
            }
          }
        },
        response: {
          200: {
            description: 'The resolved value',
            type: 'object',
            properties: {
              value: {
                description: 'Whatever the JSONPath matched — a number, string or boolean.'
              },
              fetchedAt: {
                type: 'string',
                format: 'date-time',
                description: 'When this was actually fetched from the endpoint, not from cache.'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: {
            $ref: 'ApiError#',
            description:
              'A `credentialId` was given by a caller with no authenticated session or API key.'
          },
          404: { $ref: 'ApiError#' },
          429: {
            $ref: 'ApiError#',
            description:
              "The given credential's (or, credential-free, this site's) fresh-fetch rate limit was exceeded."
          },
          502: { $ref: 'ApiError#', description: 'The endpoint could not be reached or answered.' },
          503: { $ref: 'ApiError#', description: 'The instance is in offline mode.' }
        }
      }
    },
    async (req, reply) => {
      // -> A `credentialId` is not a secret — see the header comment.
      if (req.body.credentialId && !req.apiKey && !req.session?.authenticated) {
        return reply.unauthorized(
          'Authentication is required to resolve a credentialed live-data request.'
        )
      }
      const enabledBlocks = await CARDINAL.models.blocks.getEnabledKeys(req.params.siteId)
      if (!enabledBlocks.has('live-data')) {
        return reply.notFound('The live-data block is not enabled on this site.')
      }
      return CARDINAL.models.liveData.resolve(req.params.siteId, req.body)
    }
  )
}

export default routes
