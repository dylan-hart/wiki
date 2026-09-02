import type { FastifyInstance } from 'fastify'
import {
  actorFromRequest,
  AUDIT_EVENTS,
  AUDIT_LOG_RETENTION_DAYS_FLOOR,
  type AuditEvent
} from '../models/auditLog.ts'

/**
 * Audit Log API Routes
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST AUDIT LOG ENTRIES
   */
  app.get<{
    Querystring: {
      actorId?: string
      event?: AuditEvent
      from?: string
      to?: string
      // -> Non-optional: the querystring schema declares a `default` for each, and fastify's AJV
      //    runs with `useDefaults`, so a missing param is filled in before the handler sees it.
      limit: number
      offset: number
    }
  }>(
    '/',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List audit log entries',
        description:
          'Instance-wide, permission-affecting events, newest first: user/group/permission changes, API key issuance, site settings edits, storage-target changes, and login history. Filterable by actor, event and date range. Older entries are trimmed by the `cleanAuditLog` task — see `GET /audit-log/settings`.',
        tags: ['Audit Log'],
        querystring: {
          type: 'object',
          properties: {
            actorId: { type: 'string', format: 'uuid' },
            event: { type: 'string', enum: AUDIT_EVENTS },
            from: { type: 'string', format: 'date-time', description: 'RFC 3339 Date Time' },
            to: { type: 'string', format: 'date-time', description: 'RFC 3339 Date Time' },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            offset: { type: 'integer', minimum: 0, default: 0 }
          }
        },
        response: {
          200: {
            description: 'A page of audit log entries',
            type: 'object',
            properties: {
              total: {
                type: 'integer',
                description:
                  'How many entries match the filters, which can exceed the number returned.'
              },
              limit: { type: 'integer' },
              offset: { type: 'integer' },
              entries: {
                type: 'array',
                items: { $ref: 'AuditLogEntry#' }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      const { limit, offset } = req.query
      const { total, entries } = await WIKI.models.auditLog.list({
        actorId: req.query.actorId,
        event: req.query.event,
        from: req.query.from ? new Date(req.query.from) : undefined,
        to: req.query.to ? new Date(req.query.to) : undefined,
        limit,
        offset
      })
      return { total, limit, offset, entries }
    }
  )

  /**
   * LIST AUDIT LOG ACTORS
   */
  app.get(
    '/actors',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List every actor who has ever appeared in the audit log',
        description: 'For the admin list’s actor filter.',
        tags: ['Audit Log'],
        response: {
          200: {
            description: 'List of actors',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string' }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return WIKI.models.auditLog.listActors()
    }
  )

  /**
   * GET AUDIT LOG SETTINGS
   */
  app.get(
    '/settings',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get the audit log retention setting',
        tags: ['Audit Log'],
        response: {
          200: { $ref: 'AuditLogSettings#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return { retentionDays: WIKI.models.auditLog.getRetentionDays() }
    }
  )

  /**
   * UPDATE AUDIT LOG SETTINGS
   */
  app.put<{ Body: { retentionDays: number } }>(
    '/settings',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Update the audit log retention setting',
        tags: ['Audit Log'],
        body: {
          type: 'object',
          required: ['retentionDays'],
          properties: {
            retentionDays: {
              type: 'integer',
              minimum: AUDIT_LOG_RETENTION_DAYS_FLOOR,
              maximum: 3650
            }
          }
        },
        response: {
          200: {
            description: 'Setting updated successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The setting could not be saved.' }
        }
      }
    },
    async (req, reply) => {
      const from = WIKI.models.auditLog.getRetentionDays()
      const to = req.body.retentionDays
      // OpenProject #2237: write the record BEFORE the new retention takes effect, so a shortened
      // window cannot swallow the record of its own shortening.
      await WIKI.models.auditLog.record({
        event: 'auditLog.retentionChanged',
        actor: actorFromRequest(req),
        detail: { from, to }
      })
      if (!(await WIKI.models.auditLog.setRetentionDays(to))) {
        return reply.internalServerError('Failed to save the audit log retention setting.')
      }
      return {
        ok: true,
        message: 'Audit log retention setting updated successfully.'
      }
    }
  )
}

export default routes
