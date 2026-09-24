import { JOB_STATES } from '../../models/jobs.ts'
import { actorFromRequest } from '../../models/auditLog.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'

/** A whole-instance snapshot is bounded no lower than `system/transfer.ts`'s single-site import. */
const importUploadLimit = 500 * 1024 * 1024

/**
 * Mirrors `system/transfer.ts`'s single-site `POST /import` — a raw gzip body, a queued job, a poll
 * route — for the whole instance. No `enforceApiKeySite` gate: this replaces every site, so there
 * is no one site to check a key's pin against.
 *
 * Owns its gzip body parser: `register()` is an encapsulation boundary, so no other system route
 * sees it.
 */
async function routes(app: FastifyInstance) {
  app.addContentTypeParser(
    ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
    { bodyLimit: importUploadLimit },
    (req: FastifyRequest, payload: NodeJS.ReadableStream) =>
      CARDINAL.models.replicationImport.saveUpload(payload, importUploadLimit)
  )

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
          "**This wipes and replaces the whole instance, not one site.** Every site, page, page history entry, tree entry, asset, navigation menu, user, group, group membership, classification level, comment and setting on this instance is deleted before the archive's own rows are restored, in one transaction — a failure partway through leaves the instance exactly as it was, never half-replaced. Ids are preserved exactly as the archive carries them (no remapping): this instance becomes an identical copy of the source, including — since `settings` is part of the snapshot — its session-signing secret, which ends every session on this instance the moment the restore completes. An archive whose format version this instance does not recognize is refused outright before anything is touched.\n\n**Personal notes are not carried.** A snapshot holds none, and every user's notes on this instance, with their images, are deleted along with the users and sites they belong to. Nothing restores them.",
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
      // -> `req.body` is the path the content-type parser streamed the upload to, having already
      //    checked its gzip magic number there: no in-memory buffer is left here to validate.
      const filePath = req.body

      const added = await CARDINAL.scheduler.addJob({
        task: 'replicationImport',
        payload: { filePath }
      })
      if (!added?.id) {
        await CARDINAL.models.replicationImport.deleteUpload(filePath)
        return reply.internalServerError('The scheduler could not queue the import.')
      }

      await CARDINAL.models.auditLog.record({
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
      const entry = await CARDINAL.models.jobs.getHistoryEntry(req.params.jobId)
      if (entry) {
        if (entry.task !== 'replicationImport') {
          return reply.notFound('No such import job.')
        }
        return {
          state: entry.state,
          result: entry.result ?? null
        }
      }

      const pending = await CARDINAL.models.jobs.getPendingEntry(req.params.jobId)
      if (!pending || pending.task !== 'replicationImport') {
        return reply.notFound('No such import job.')
      }
      return { state: 'queued', result: null }
    }
  )
}

export default routes
