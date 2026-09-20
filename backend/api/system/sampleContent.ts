import { actorFrom } from '../../helpers/pageAccess.ts'
import { SITE_MISSING_MESSAGE } from '../../helpers/siteResolution.ts'
import { actorFromRequest } from '../../models/auditLog.ts'
import { generate, purge } from '../../models/sampleContent.ts'
import type { FastifyInstance } from 'fastify'

const siteBody = {
  type: 'object',
  required: ['siteId'],
  properties: {
    siteId: { type: 'string', format: 'uuid' }
  }
}

const countResponse = (description: string, countDescription: string) => ({
  description,
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    count: { type: 'number', description: countDescription }
  }
})

async function routes(app: FastifyInstance) {
  app.post<{ Body: { siteId: string } }>(
    '/sampleContent/generate',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Generate sample content',
        description:
          'Writes the Welcome space into the site through the same path an editor saves a page by, so history, the tree and storage targets stay correct. Every page carries a reserved tag and lives under a reserved path prefix, which is what the purge route selects on to remove them again. Refuses with a 409 when the site already holds sample content: purge it first. A path already taken by a real page fails the request rather than overwriting it.',
        tags: ['System'],
        body: siteBody,
        response: {
          200: countResponse('Sample content generated successfully', 'Pages created.'),
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            $ref: 'ApiError#',
            description: 'Sample content already exists for this site, or a path is taken.'
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized()
      }
      if (!CARDINAL.sites[req.body.siteId]) {
        return reply.notFound(SITE_MISSING_MESSAGE)
      }

      const result = await generate(req.body.siteId, actor)

      await CARDINAL.models.auditLog.record({
        event: 'system.sampleContentGenerated',
        actor: actorFromRequest(req),
        siteId: req.body.siteId,
        detail: { count: result.created }
      })

      return {
        ok: true,
        message: `Generated ${result.created} sample page(s).`,
        count: result.created
      }
    }
  )

  app.post<{ Body: { siteId: string } }>(
    '/sampleContent/purge',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Purge sample content',
        description:
          'Deletes the pages that carry both the reserved sample-content tag and sit under the reserved path prefix, each through the normal page delete. A page that has only one of the two is real content and is left alone. Safe to repeat: with nothing to remove it answers a count of zero.',
        tags: ['System'],
        body: siteBody,
        response: {
          200: countResponse('Sample content purged successfully', 'Pages deleted.'),
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized()
      }
      if (!CARDINAL.sites[req.body.siteId]) {
        return reply.notFound(SITE_MISSING_MESSAGE)
      }

      const result = await purge(req.body.siteId, actor)

      await CARDINAL.models.auditLog.record({
        event: 'system.sampleContentPurged',
        actor: actorFromRequest(req),
        siteId: req.body.siteId,
        detail: { found: result.found, count: result.deleted }
      })

      return {
        ok: true,
        message: `Purged ${result.deleted} sample page(s).`,
        count: result.deleted
      }
    }
  )
}

export default routes
