import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { actorFromRequest } from '../../models/auditLog.ts'
import type { FastifyInstance } from 'fastify'

/**
 * Instance-wide replication snapshot export — the SOURCE side of Epic #2437's scheduled clean-slate
 * replication (prod -> staging mirror), designed in WP #2489. Mirrors `transfer.ts`'s export/download
 * pair (queue a background job, poll/download it once) but produces a whole-instance snapshot
 * (`WIKI.models.replicationExport`) rather than one site's content (`WIKI.models.export`) — a
 * deliberately separate archive format and feature, not a variant of the existing "Export content"
 * system utility.
 *
 * No route here accepts a request body naming which data to include: full-parity scope (pages+
 * history, users/groups, assets, navigation, settings, classification levels, comments) is the whole
 * point of this surface per Feature #2437's resolved scope, so there is nothing to select. The
 * target-side import (wipe-and-replace) and the scheduler/admin-settings wiring that will actually
 * call this on a schedule are separate work packages (#2490, #2491, #2492) — this plugin only makes
 * the export itself reachable and testable.
 */
async function routes(app: FastifyInstance) {
  /**
   * EXPORT REPLICATION SNAPSHOT
   */
  app.post(
    '/replication/export',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Export a whole-instance replication snapshot',
        description:
          'Queues a background job that serializes the ENTIRE instance -- every site\'s pages, tree, page history, navigation, comments and assets (with their stored bytes), plus instance-wide sites, classification levels, settings and users/groups -- into a single gzipped tarball under `<dataPath>/exports/`. This is a different archive from `POST /export` (which serializes one site for the "Export content" utility): full instance parity is the point of this route. A large instance can take a while to serialize, so allow the request a correspondingly long timeout even though the response itself only says the job was queued -- poll the scheduler view for completion, then call the download route below.',
        tags: ['System'],
        response: {
          200: {
            description: 'Export queued successfully',
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
                format: 'uuid',
                description: 'ID of the queued job. Pass it to the download route below.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      // -> Instance-wide, no `siteId` -- unlike `POST /export`, there is no `enforceApiKeySite()`
      //    boundary to check here either: `manage:system` already bypasses the site-pin scope
      //    entirely (see `helpers/apiKeySite.ts`), and a route with no `siteId` in its body has
      //    nothing for that check to compare against.
      const added = await WIKI.scheduler.addJob({ task: 'exportReplication' })
      if (!added?.id) {
        return reply.internalServerError('The scheduler could not queue the replication export.')
      }

      await WIKI.models.auditLog.record({
        event: 'system.replicationSnapshotExported',
        actor: actorFromRequest(req),
        detail: { jobId: added.id }
      })

      return {
        ok: true,
        message: 'Replication snapshot export queued successfully.',
        id: added.id
      }
    }
  )

  /**
   * DOWNLOAD REPLICATION SNAPSHOT
   */
  app.get<{ Params: { jobId: string } }>(
    '/replication/export/:jobId/download',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Download a finished replication snapshot',
        description:
          "404s when no such export job exists (or its file has already been cleaned up), 409 when the job exists but has not completed yet. The file is deleted once it has finished streaming, so a job's tarball can only be downloaded once — queue a fresh export for another copy.",
        tags: ['System'],
        params: {
          type: 'object',
          required: ['jobId'],
          properties: {
            jobId: {
              type: 'string',
              format: 'uuid'
            }
          }
        },
        response: {
          200: {
            description: 'The snapshot tarball',
            content: {
              'application/gzip': {
                schema: {
                  type: 'string',
                  format: 'binary'
                }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const entry = await WIKI.models.jobs.getHistoryEntry(req.params.jobId)
      if (!entry || entry.task !== 'exportReplication') {
        return reply.notFound('No such replication export job.')
      }
      if (entry.state !== 'completed') {
        return reply.conflict('This replication export has not finished yet.')
      }

      const result = entry.result as { filePath: string; fileSize: number } | null
      if (!result?.filePath) {
        return reply.notFound('This replication export left no file behind.')
      }

      let stat
      try {
        stat = await fsp.stat(result.filePath)
      } catch {
        return reply.notFound('This replication export file is no longer available.')
      }

      const stream = fs.createReadStream(result.filePath)
      // -> Best-effort cleanup once the bytes are actually on the wire, not before: deleting on the
      //    happy path here is what keeps a downloaded snapshot from sitting in `<dataPath>/exports/`
      //    until `purgeExpired` gets to it on its own schedule.
      stream.on('close', () => {
        WIKI.models.replicationExport.deleteExport(result.filePath).catch(() => {})
      })

      reply.header(
        'Content-Disposition',
        `attachment; filename="replication-export-${entry.id}.tar.gz"`
      )
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Content-Length', stat.size)
      return reply.type('application/gzip').send(stream)
    }
  )
}

export default routes
