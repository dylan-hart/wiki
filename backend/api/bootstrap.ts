import { whoAmI } from './users/admin.ts'
import { buildSitePayload } from './sites.ts'
import { guardSiteEnabled } from '../helpers/siteResolution.ts'
import type { FastifyInstance } from 'fastify'

/**
 * What the app has to know before it can draw anything — site, system flags, session — in one
 * request rather than three round trips to each one's own endpoint.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Querystring: { hostname?: string } }>(
    '/',
    {
      config: {
        publicAccess: true
      },
      schema: {
        summary: 'Everything the app needs to start',
        description:
          'The site for the hostname, the system flags, and the current session — the same answers `sites/{hostname}`, `system/flags` and `users/whoami` give, in one request.\n\nCarries the session, so it is never cached.',
        tags: ['System'],
        querystring: {
          type: 'object',
          properties: {
            hostname: {
              type: 'string',
              maxLength: 255,
              description: "The host the browser is on. The request's own hostname when absent."
            }
          }
        },
        response: {
          200: {
            description: 'Site, flags and session',
            type: 'object',
            properties: {
              site: { $ref: 'Site#' },
              flags: { $ref: 'SystemFlags#' },
              user: {
                type: 'object',
                description:
                  'As `users/whoami` answers it: `authenticated: false` alone for a guest, otherwise the account and its group-wide permissions.',
                additionalProperties: true
              }
            }
          },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      // -> The session decides part of the answer, so no shared cache may hold on to it
      reply.preventCache()
      const site = await CARDINAL.models.sites.getSiteByHostname({
        hostname: req.query.hostname ?? req.hostname
      })
      if (!site) {
        return reply.notFound('There is no wiki site at this hostname.')
      }
      // -> Resolved by hostname, not a `:siteId`, so `siteEnabledPreHandler` never sees this site —
      //    and the whole SPA boots against this response.
      if (guardSiteEnabled(site, reply)) {
        return reply
      }
      return {
        site: await buildSitePayload(site, req),
        flags: CARDINAL.models.flags.getFlags(),
        user: await whoAmI(req)
      }
    }
  )
}

export default routes
