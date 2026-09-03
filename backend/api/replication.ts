import { CronExpressionParser } from 'cron-parser'
import { actorFromRequest } from '../models/auditLog.ts'
import type { FastifyInstance } from 'fastify'

/**
 * Placeholder sent to the client in place of the stored bearer token. Sending it back unchanged
 * leaves the stored token alone -- the same masking contract `api/mail.ts` uses for `pass` and
 * `dkimPrivateKey`.
 */
const TOKEN_MASK = '********'

/** Fields stored in the `replication` settings blob (OpenProject #2437/#2491). */
const REPLICATION_CONFIG_KEYS = ['isEnabled', 'sourceUrl', 'bearerToken', 'cronSchedule'] as const

/**
 * Whether `value` parses as a cron expression `core/scheduler.ts`'s own `CronExpressionParser` would
 * accept -- reusing the identical package/call is what keeps "accepted here" meaning "will actually
 * run" once the scheduled job itself is wired up (OpenProject #2492).
 */
function isValidCron(value: string): boolean {
  try {
    CronExpressionParser.parse(value, { tz: 'UTC' })
    return true
  } catch {
    return false
  }
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Validate a replication config patch merged onto the current stored config.
 *
 * @returns The reason it is invalid, or null when it is fine
 */
function validate(merged: Record<string, any>): string | null {
  if (merged.sourceUrl && !isValidUrl(merged.sourceUrl)) {
    return 'The source instance URL must be a valid http:// or https:// URL.'
  }
  if (merged.cronSchedule && !isValidCron(merged.cronSchedule)) {
    return 'The cron schedule is not a valid cron expression.'
  }
  // -> A half-configured instance must never be armed: enabling the scheduled pull requires all
  //    three of the fields it depends on to already be set.
  if (merged.isEnabled) {
    if (!merged.sourceUrl) {
      return 'A source instance URL is required to enable replication.'
    }
    if (!merged.bearerToken) {
      return 'A bearer token is required to enable replication.'
    }
    if (!merged.cronSchedule) {
      return 'A cron schedule is required to enable replication.'
    }
  }
  return null
}

/**
 * Instance-level Replication settings (OpenProject #2437/#2491): source instance URL, bearer token
 * and cron schedule for a scheduled, wipe-and-replace pull from another instance. This is
 * configuration only -- the actual bulk-export/import wire protocol (#2489/#2490) and the scheduler
 * wiring that reads `cronSchedule` (#2492) are separate work.
 */
async function routes(app: FastifyInstance) {
  /**
   * GET REPLICATION CONFIG
   */
  app.get(
    '/config',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get replication configuration',
        description:
          'Instance-level scheduled replication settings. `bearerToken` is returned masked when a token is stored.',
        tags: ['Replication'],
        response: {
          200: {
            description: 'Replication configuration',
            type: 'object',
            $ref: 'ReplicationConfig#'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return {
        isEnabled: WIKI.config.replication?.isEnabled === true,
        sourceUrl: WIKI.config.replication?.sourceUrl ?? '',
        bearerToken: WIKI.config.replication?.bearerToken?.length > 0 ? TOKEN_MASK : '',
        cronSchedule: WIKI.config.replication?.cronSchedule ?? ''
      }
    }
  )

  /**
   * UPDATE REPLICATION CONFIG
   */
  app.put<{
    Body: {
      isEnabled?: boolean
      sourceUrl?: string
      bearerToken?: string
      cronSchedule?: string
    }
  }>(
    '/config',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Update replication configuration',
        description:
          'Accepts any subset of the fields. Enabling replication requires sourceUrl, bearerToken and cronSchedule to all already be set (in this request or already stored).',
        tags: ['Replication'],
        body: {
          $ref: 'ReplicationConfig#'
        },
        response: {
          200: {
            description: 'Replication configuration updated successfully',
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
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The configuration could not be saved.' }
        }
      }
    },
    async (req, reply) => {
      const patch: Record<string, any> = {}
      for (const key of REPLICATION_CONFIG_KEYS) {
        if (req.body[key] !== undefined) {
          patch[key] = req.body[key]
        }
      }

      // -> Trailing slash is stripped up front so a stored sourceUrl composes cleanly once the
      //    bulk-export API path is appended (#2489).
      if (typeof patch.sourceUrl === 'string') {
        patch.sourceUrl = patch.sourceUrl.trim().replace(/\/+$/, '')
      }
      if (typeof patch.cronSchedule === 'string') {
        patch.cronSchedule = patch.cronSchedule.trim()
      }

      // -> The client only ever receives a masked token, so an unchanged one must not be stored
      if (patch.bearerToken === TOKEN_MASK) {
        delete patch.bearerToken
      }

      const previousConfig = WIKI.config.replication
      const merged = { ...previousConfig, ...patch }

      const invalid = validate(merged)
      if (invalid) {
        return reply.badRequest(invalid)
      }

      WIKI.config.replication = merged

      if (!(await WIKI.configSvc.saveToDb(['replication']))) {
        WIKI.config.replication = previousConfig
        return reply.internalServerError('Failed to save replication configuration.')
      }

      // -> Never write the raw bearer token to the audit log, even though it was accepted in the
      //    request body.
      const auditDetail = { ...patch }
      if ('bearerToken' in auditDetail) {
        auditDetail.bearerToken = TOKEN_MASK
      }
      await WIKI.models.auditLog.record({
        event: 'system.replicationUpdated',
        actor: actorFromRequest(req),
        detail: auditDetail
      })

      return {
        ok: true,
        message: 'Replication configuration updated successfully.'
      }
    }
  )
}

export default routes
