import { JOB_STATES } from '../../models/jobs.ts'
import { actorFromRequest } from '../../models/auditLog.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'

/** How large an uploaded replication snapshot may be — a whole instance's worth of asset bytes, not
 *  one site's. Same magnitude as `system/transfer.ts`'s own single-site import ceiling; a snapshot
 *  covering every site is not bounded any lower than that. */
const importUploadLimit = 500 * 1024 * 1024

/**
 * Target-side bulk-import API surface for Feature #2437's scheduled replication
 * (`docs/decisions/bulk-replication-wire-format.md`): accept a whole-instance snapshot archive and
 * wipe-and-replace this instance's data with it.
 *
 * Mirrors `system/transfer.ts`'s single-site `POST /import` in shape — a raw gzip body rather than a
 * multipart form, queued as a background job, polled for completion — scoped to the whole instance
 * instead of one site and with no `targetSiteId`/`enforceApiKeySite` gate: this replaces every site,
 * not one an API key could be pinned to. `manage:system` only, deliberately not reachable through a
 * site-scoped API key at all (see `core/http/authHooks.ts`'s API-key site pin — a key pinned to one
 * site has no business wiping every other one).
 *
 * Owns the gzip body parser its upload route needs, same reasoning as `transfer.ts`: `register()` is
 * a real encapsulation boundary, so no other system route sees it.
 */
async function routes(app: FastifyInstance) {
  app.addContentTypeParser(
    ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
    { bodyLimit: importUploadLimit },
    (req: FastifyRequest, payload: NodeJS.ReadableStream) =>
      WIKI.models.replicationImport.saveUpload(payload, importUploadLimit)
  )

  /**
   * IMPORT REPLICATION SNAPSHOT
   */
  app.post<{ Body: string }>(
    '/replication/import',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Wipe this instance and replace it with a replication snapshot',
        description:
          `The body is the raw archive a source instance's bulk-export produced, not a multipart form — send the file itself with its \`Content-Type\`. At most ${importUploadLimit / 1024 / 1024} MB. Queues a background job: reading a whole-instance archive back apart and restoring it inside a transaction is not something a request thread should be blocked on — poll the returned job id for completion.\n\n` +
          "**This wipes and replaces the whole instance, not one site.** Every site, page, page history entry, tree entry, asset, navigation menu, user, group, group membership, classification level, comment and setting on this instance is deleted before the archive's own rows are restored, in one transaction — a failure partway through leaves the instance exactly as it was, never half-replaced. Ids are preserved exactly as the archive carries them (no remapping): this instance becomes an identical copy of the source, including — since `settings` is part of the snapshot — its session-signing secret, which ends every session on this instance the moment the restore completes. See `docs/decisions/bulk-replication-wire-format.md` for the full contract. An archive whose format version this instance does not recognize is refused outright before anything is touched.",
        tags: ['System'],
        consumes: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
        response: {
          200: {
            description: 'Import queued successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              id: {
                type: 'string',
                format: 'uuid',
                description: 'ID of the queued job. Pass it to the status route below.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      // -> The content-type parser above already streamed the body to disk — validating it (gzip
      //    magic number, non-empty) as part of that same save, since there is no in-memory buffer
      //    left here to check. `req.body` is the path it landed at.
      const filePath = req.body

      const added = await WIKI.scheduler.addJob({
        task: 'replicationImport',
        payload: { filePath }
      })
      if (!added?.id) {
        await WIKI.models.replicationImport.deleteUpload(filePath)
        return reply.internalServerError('The scheduler could not queue the import.')
      }

      await WIKI.models.auditLog.record({
        event: 'system.replicationImported',
        actor: actorFromRequest(req),
        detail: { jobId: added.id }
      })

      return {
        ok: true,
        message: 'Replication import queued successfully.',
        id: added.id
      }
    }
  )

  /**
   * GET REPLICATION IMPORT JOB
   */
  app.get<{ Params: { jobId: string } }>(
    '/replication/import/:jobId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get a replication import job',
        description:
          "The job's current state, and its per-table restore counts once `state` is `completed`. 404s when no such import job exists.",
        tags: ['System'],
        params: {
          type: 'object',
          properties: {
            jobId: { type: 'string', format: 'uuid' }
          },
          required: ['jobId']
        },
        response: {
          200: {
            description: 'Import job state and, once completed, its restore counts',
            type: 'object',
            properties: {
              state: {
                type: 'string',
                enum: ['queued', ...JOB_STATES],
                description:
                  '`queued` while still waiting to be picked up — it has not reached job history yet.'
              },
              result: {
                type: 'object',
                nullable: true,
                description: 'Null until the job has completed. Rows restored, per table.',
                properties: {
                  sites: { type: 'integer' },
                  classificationLevels: { type: 'integer' },
                  groups: { type: 'integer' },
                  users: { type: 'integer' },
                  userGroups: { type: 'integer' },
                  navigation: { type: 'integer' },
                  tree: { type: 'integer' },
                  pages: { type: 'integer' },
                  pageHistory: { type: 'integer' },
                  assets: { type: 'integer' },
                  comments: { type: 'integer' },
                  settings: { type: 'integer' }
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
      if (entry) {
        if (entry.task !== 'replicationImport') {
          return reply.notFound('No such import job.')
        }
        return {
          state: entry.state,
          result: entry.result ?? null
        }
      }

      // -> Not in history yet: it may simply not have been picked up off the queue by any instance
      //    yet, which is not the same as not existing (see `Jobs#getPendingEntry`).
      const pending = await WIKI.models.jobs.getPendingEntry(req.params.jobId)
      if (!pending || pending.task !== 'replicationImport') {
        return reply.notFound('No such import job.')
      }
      return { state: 'queued', result: null }
    }
  )
}

export default routes
