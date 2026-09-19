import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { enforceApiKeySite } from '../../helpers/apiKeySite.ts'
import { JOB_STATES } from '../../models/jobs.ts'
import { actorFromRequest } from '../../models/auditLog.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'

/** Sized for a whole site's worth of asset bytes, not one image. */
const importUploadLimit = 500 * 1024 * 1024

async function routes(app: FastifyInstance) {
  // -> A raw archive rather than a multipart form: one file, no fields, no dependency to add.
  //    Registered inside this plugin, and `register()` is an encapsulation boundary, so every other
  //    route keeps rejecting this body. The accepted types cover what a browser reports for a
  //    `.tar.gz` across platforms.
  //
  // -> No `parseAs`, deliberately: that is what hands the parser the raw request stream instead of
  //    a buffered `Buffer`, so `saveUpload` streams straight to `<dataPath>/imports/`. It also has
  //    to enforce `bodyLimit` itself as bytes arrive: Fastify only does so for the buffered kinds.
  app.addContentTypeParser(
    ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
    { bodyLimit: importUploadLimit },
    (req: FastifyRequest, payload: NodeJS.ReadableStream) =>
      CARDINAL.models.import.saveUpload(payload, importUploadLimit)
  )

  app.post<{ Body: { siteId: string } }>(
    '/export',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: "Export a site's content",
        description:
          'Queues a background job that serializes the pages, tree, assets (with their stored bytes) and groups into a single tarball under `<dataPath>/exports/`. Mirrors `POST /extensions/:key/install`: a large site can take a while to serialize, so allow the request a correspondingly long timeout even though the response itself only says the job was queued — poll the scheduler view for completion, then call the download route below.',
        tags: ['System'],
        body: {
          type: 'object',
          required: ['siteId'],
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          }
        },
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
                description:
                  'ID of the queued job. Pass it to the download route once it completes.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      // -> No `enforceApiKeySite()` on this body `siteId`, on purpose: see `helpers/apiKeySite.ts`.
      const added = await CARDINAL.scheduler.addJob({
        task: 'exportContent',
        payload: { siteId: req.body.siteId }
      })
      if (!added?.id) {
        return reply.internalServerError('The scheduler could not queue the export.')
      }

      await CARDINAL.models.auditLog.record({
        event: 'system.contentExported',
        actor: actorFromRequest(req),
        targetType: 'site',
        targetId: req.body.siteId,
        detail: { jobId: added.id }
      })

      return {
        ok: true,
        message: 'Content export queued successfully.',
        id: added.id
      }
    }
  )

  app.get<{ Params: { jobId: string } }>(
    '/export/:jobId/download',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Download a finished content export',
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
            description: 'The tarball',
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
      const entry = await CARDINAL.models.jobs.getHistoryEntry(req.params.jobId)
      if (!entry || entry.task !== 'exportContent') {
        return reply.notFound('No such export job.')
      }
      if (entry.state !== 'completed') {
        return reply.conflict('This export has not finished yet.')
      }

      const result = entry.result as { filePath: string; fileSize: number } | null
      if (!result?.filePath) {
        return reply.notFound('This export left no file behind.')
      }

      let stat
      try {
        stat = await fsp.stat(result.filePath)
      } catch {
        return reply.notFound('This export file is no longer available.')
      }

      const stream = fs.createReadStream(result.filePath)
      // -> On `close`, so the bytes are on the wire first. Best-effort: `purgeExports` sweeps up.
      stream.on('close', () => {
        CARDINAL.models.export.deleteExport(result.filePath).catch(() => {})
      })

      reply.header('Content-Disposition', `attachment; filename="export-${entry.id}.tar.gz"`)
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Content-Length', stat.size)
      return reply.type('application/gzip').send(stream)
    }
  )

  app.post<{ Querystring: { targetSiteId: string }; Body: string }>(
    '/import',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Import content into a site',
        description:
          "The body is the raw archive produced by `POST /export`'s download, not a multipart form — send the file itself with its `Content-Type`. At most " +
          `${importUploadLimit / 1024 / 1024} MB. Queues a background job, mirroring \`POST /export\`: reading a whole archive back apart and restoring it is not something a request thread should be blocked on, so the response only confirms the job was queued — poll the scheduler view for completion.\n\n` +
          "**This replaces the target site's content, it does not merge with it.** Every page, tree entry (folder/page/asset) and asset already on `targetSiteId` is deleted before the archive's own are restored — an import puts the site back to exactly what the archive describes. Groups are the one exception: being global rather than site-scoped, each imported group updates one already on this instance if its id matches, or is added as a new one otherwise, rather than the whole `groups` table being replaced. The target site's own config, hostname and enabled state are left untouched — only pages, tree entries, assets and groups are restored. Every restored page's and asset's author/creator/owner is rewritten to the account performing the import, since accounts are not part of the archive, and every restored page/tree entry/asset gets a freshly generated id rather than reusing the one it had in the archive — that id space is instance-wide, not per-site, so reusing it would collide with the source site's own rows the moment that site still exists in the same database (restoring onto a *different* site than the one exported, or restoring a backup while the original is still around, are both ordinary uses of this). Groups are the one exception, matched by id on purpose.\n\nThe restore runs inside a single database transaction: a failure partway through — a malformed archive, a constraint violation — leaves the target site exactly as it was, never half-restored. An archive whose format version this instance does not recognize is refused outright before anything is touched, the same way.",
        tags: ['System'],
        consumes: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
        querystring: {
          type: 'object',
          required: ['targetSiteId'],
          properties: {
            targetSiteId: {
              type: 'string',
              format: 'uuid',
              description: 'The site whose content is replaced by this archive.'
            }
          }
        },
        response: {
          200: {
            description: 'Import queued successfully',
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
                description: 'ID of the queued job.'
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
      // -> `targetSiteId` is a querystring field, so the global site-pin `preHandler` never sees
      //    it. The upload is already on disk by now, so every early return has to delete it.
      if (!enforceApiKeySite(req, reply, req.query.targetSiteId)) {
        await CARDINAL.models.import.deleteUpload(filePath)
        return
      }

      const targetSite = await CARDINAL.models.sites.getSiteById({ id: req.query.targetSiteId })
      if (!targetSite) {
        await CARDINAL.models.import.deleteUpload(filePath)
        return reply.notFound('Target site does not exist.')
      }

      const added = await CARDINAL.scheduler.addJob({
        task: 'importContent',
        payload: {
          filePath,
          targetSiteId: req.query.targetSiteId,
          importedById: req.session.user!.id
        }
      })
      if (!added?.id) {
        await CARDINAL.models.import.deleteUpload(filePath)
        return reply.internalServerError('The scheduler could not queue the import.')
      }

      await CARDINAL.models.auditLog.record({
        event: 'system.contentImported',
        actor: actorFromRequest(req),
        targetType: 'site',
        targetId: req.query.targetSiteId,
        detail: { jobId: added.id }
      })

      return {
        ok: true,
        message: 'Content import queued successfully.',
        id: added.id
      }
    }
  )

  app.post(
    '/pages/scan',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Scan for page problems',
        description:
          'Queues a background job that runs five integrity checks across every site: pages whose stored hash has drifted from their path, tree entries and pages that have diverged from each other, duplicate (site, locale, path) tuples, page relations pointing at a page that no longer exists, and pages/tree rows whose path starts with an installed locale code. Runs in the background — a full scan is not instant on a large wiki — and only reports; nothing is repaired automatically. Poll `GET /pages/scan/:jobId` for the result.',
        tags: ['System'],
        response: {
          200: {
            description: 'Scan queued successfully',
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
      const added = await CARDINAL.scheduler.addJob({ task: 'scanPageProblems' })
      if (!added?.id) {
        return reply.internalServerError('The scheduler could not queue the scan.')
      }
      return {
        ok: true,
        message: 'Page problems scan queued successfully.',
        id: added.id
      }
    }
  )

  app.get<{ Params: { jobId: string } }>(
    '/pages/scan/:jobId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get a page problems scan job',
        description:
          "The job's current state, and its report once `state` is `completed`. 404s when no such scan job exists.",
        tags: ['System'],
        params: {
          type: 'object',
          properties: {
            jobId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['jobId']
        },
        response: {
          200: {
            description: 'Scan job state and, once completed, its report',
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
                description: 'Null until the job has completed.',
                properties: {
                  hashDrift: {
                    type: 'object',
                    description:
                      'Pages whose stored hash no longer matches generatePathHash(path).',
                    properties: {
                      count: { type: 'integer' },
                      entries: { type: 'array', items: { type: 'object' } }
                    }
                  },
                  treeDivergence: {
                    type: 'object',
                    description:
                      'Tree entries and pages that have diverged from each other, matched by id.',
                    properties: {
                      count: { type: 'integer' },
                      entries: { type: 'array', items: { type: 'object' } }
                    }
                  },
                  duplicatePaths: {
                    type: 'object',
                    description: 'Groups of pages sharing the same (siteId, locale, path).',
                    properties: {
                      count: { type: 'integer' },
                      entries: { type: 'array', items: { type: 'object' } }
                    }
                  },
                  brokenRelations: {
                    type: 'object',
                    description: 'Page relations pointing at a page that no longer exists.',
                    properties: {
                      count: { type: 'integer' },
                      entries: { type: 'array', items: { type: 'object' } }
                    }
                  },
                  localeCollisions: {
                    type: 'object',
                    description:
                      'Pages/tree rows whose path starts with an installed locale code, grandfathered in from before that segment was reserved.',
                    properties: {
                      count: { type: 'integer' },
                      entries: { type: 'array', items: { type: 'object' } }
                    }
                  },
                  scannedAt: {
                    type: 'string',
                    format: 'date-time'
                  }
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
        if (entry.task !== 'scanPageProblems') {
          return reply.notFound('No such scan job.')
        }
        return {
          state: entry.state,
          result: entry.result ?? null
        }
      }

      const pending = await CARDINAL.models.jobs.getPendingEntry(req.params.jobId)
      if (!pending || pending.task !== 'scanPageProblems') {
        return reply.notFound('No such scan job.')
      }
      return { state: 'queued', result: null }
    }
  )
}

export default routes
