import type { FastifyInstance } from 'fastify'
import type { LiveDataRequest } from '../models/liveData.ts'

/**
 * Live Data API Routes (OpenProject #868)
 *
 * One route: resolve a `block-live-data` instance's data server-side (see `models/liveData.ts`),
 * for the block itself to call from a reader's browser.
 *
 * No route-level `permissions`, and no per-page read check either — a reader only ever reaches this
 * because they already loaded a page whose content the wiki decided they may read, and this route
 * answers with the same class of thing `blocksConfigFor()` in `api/sites.ts` already hands every
 * reader publicly (a block's own resolved data), not the page itself. What it must never do, and
 * does not, is hand back the credential that produced it — see `models/liveData.ts`.
 *
 * That "no route-level permissions" is NOT the same as "unauthenticated for every request", though
 * (OpenProject #2185 — this header comment used to say so, incorrectly): a `credentialId` is not
 * itself a secret (it travels in plain page markdown as a block prop — see
 * `models/blockCredentials.ts`'s header comment), so an anonymous caller who has merely learned one
 * from a rendered page could otherwise drive an authenticated proxy request to anywhere the
 * credential's allowlist permits, without ever needing to read the page the credential is legitimately
 * used on. The handler below refuses a `credentialId` from a caller with no authenticated session (or
 * API key) — leaving the credential-free path, which was always the genuinely public one, unaffected.
 */
async function routes(app: FastifyInstance) {
  /**
   * RESOLVE A LIVE-DATA BLOCK'S VALUE
   */
  app.post<{ Params: { siteId: string }; Body: LiveDataRequest }>(
    '/sites/:siteId/live-data/resolve',
    {
      schema: {
        summary: "Resolve a block-live-data instance's value",
        description:
          "Fetches the given URL server-side — with the stored credential's secret as a bearer token, when `credentialId` is given — and extracts one value from the JSON response by JSONPath. Cached per site/credential/url/jsonPath for the given `refreshInterval` (clamped to 10s–24h), so several readers with the same block open share one upstream request. Fresh (cache-miss) fetches are rate-limited independent of that cache, per credential (or per site for a credential-free request) — see `models/liveData.ts`. `credentialId` requires an authenticated caller (a session or an API key); a credential-free request needs neither. Gated by the site's `live-data` block toggle, same as every other block.",
        tags: ['Blocks'],
        params: {
          type: 'object',
          properties: { siteId: { type: 'string', format: 'uuid' } },
          required: ['siteId']
        },
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
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      const enabledBlocks = await WIKI.models.blocks.getEnabledKeys(req.params.siteId)
      if (!enabledBlocks.has('live-data')) {
        return reply.notFound('The live-data block is not enabled on this site.')
      }
      // -> A `credentialId` is not itself a secret (see the header comment above), so an anonymous
      //    caller who has merely learned one must not be able to drive an authenticated proxy
      //    request with it. The credential-free path needs no such check: it was always the
      //    genuinely public one.
      if (req.body.credentialId && !req.apiKey && !req.session?.authenticated) {
        return reply.unauthorized('An authenticated caller is required to use a stored credential.')
      }
      return WIKI.models.liveData.resolve(req.params.siteId, req.body)
    }
  )
}

export default routes
