import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { enforceApiKeySite } from '../../helpers/apiKeySite.ts'
import { JOB_STATES } from '../../models/jobs.ts'
import { actorFromRequest } from '../../models/auditLog.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'

/** How large an uploaded content archive may be — a whole site's worth of asset bytes, not one image. */
const importUploadLimit = 500 * 1024 * 1024

/**
 * Moving a site's content in and out of this instance: the export job and its download, the
 * streamed archive import, and the content scan that reports what an import would find. Owns the
 * gzip body parser the import upload needs -- `register()` is a real encapsulation boundary, so no
 * other system route sees it.
 */
async function routes(app: FastifyInstance) {
  // -> An import upload is the raw archive rather than a multipart form, same reasoning and same
  //    pattern as `PUT /sites/:siteId/images/:kind`: one file, no fields, no dependency to add.
  //    Registered inside this plugin, so every other route keeps rejecting this body outright. The
  //    accepted types cover what a browser reports for a `.tar.gz` across platforms.
  //
  // -> No `parseAs` here, deliberately: that's what hands the parser the raw request stream instead
  //    of a fully-buffered `Buffer` (Fastify only auto-buffers for `parseAs: 'buffer' | 'string'`).
  //    `saveUpload` streams it straight to `<dataPath>/imports/`, so a 500 MB archive never sits
  //    resident in the request thread's memory as one allocation — see `models/siteImport.ts`. It
  //    also takes over enforcing `bodyLimit` as bytes arrive, since Fastify's own automatic
  //    `Content-Length` check only runs for the buffered parser kinds.
  app.addContentTypeParser(
    ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
    { bodyLimit: importUploadLimit },
    (req: FastifyRequest, payload: NodeJS.ReadableStream) =>
      WIKI.models.import.saveUpload(payload, importUploadLimit)
  )

  /**
   * EXPORT CONTENT
   */
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
      // -> `siteId` here is a body field, not `req.params.siteId`, and this route is `manage:system`
      //    only -- no `enforceApiKeySite()` call; see `helpers/apiKeySite.ts`'s doc comment for why.
      const added = await WIKI.scheduler.addJob({
        task: 'exportContent',
        payload: { siteId: req.body.siteId }
      })
      if (!added?.id) {
        return reply.internalServerError('The scheduler could not queue the export.')
      }

      await WIKI.models.auditLog.record({
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

  /**
   * DOWNLOAD CONTENT EXPORT
   */
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
      const entry = await WIKI.models.jobs.getHistoryEntry(req.params.jobId)
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
      // -> Best-effort cleanup once the bytes are actually on the wire, not before: deleting on the
      //    happy path here is what keeps a downloaded export from sitting in `<dataPath>/exports/`
      //    until `purgeExports` gets to it on its own schedule.
      stream.on('close', () => {
        WIKI.models.export.deleteExport(result.filePath).catch(() => {})
      })

      reply.header('Content-Disposition', `attachment; filename="export-${entry.id}.tar.gz"`)
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Content-Length', stat.size)
      return reply.type('application/gzip').send(stream)
    }
  )

  /**
   * IMPORT CONTENT
   */
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
      // -> The content-type parser above already streamed the body to disk — validating it (gzip
      //    magic number, non-empty) as part of that same save, since there is no in-memory buffer
      //    left here to check. `req.body` is the path it landed at.
      const filePath = req.body
      // -> OpenProject #2201: targetSiteId comes from the querystring, not `req.params`, so the
      //    global preHandler in `index.ts` never sees it -- checked before anything else, since this
      //    route replaces the target site's entire content. The upload is already on disk by the
      //    time this runs (the content-type parser above saved it), so a refusal here still has to
      //    clean it up rather than leaving it orphaned, same as every other early return below.
      if (!enforceApiKeySite(req, reply, req.query.targetSiteId)) {
        await WIKI.models.import.deleteUpload(filePath)
        return
      }

      const targetSite = await WIKI.models.sites.getSiteById({ id: req.query.targetSiteId })
      if (!targetSite) {
        await WIKI.models.import.deleteUpload(filePath)
        return reply.notFound('Target site does not exist.')
      }

      const added = await WIKI.scheduler.addJob({
        task: 'importContent',
        payload: {
          filePath,
          targetSiteId: req.query.targetSiteId,
          importedById: req.session.user!.id
        }
      })
      if (!added?.id) {
        await WIKI.models.import.deleteUpload(filePath)
        return reply.internalServerError('The scheduler could not queue the import.')
      }

      await WIKI.models.auditLog.record({
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

  /**
   * SCAN FOR PAGE PROBLEMS
   */
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
      const added = await WIKI.scheduler.addJob({ task: 'scanPageProblems' })
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

  /**
   * GET PAGE PROBLEMS SCAN RESULT
   */
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
      const entry = await WIKI.models.jobs.getHistoryEntry(req.params.jobId)
      if (entry) {
        if (entry.task !== 'scanPageProblems') {
          return reply.notFound('No such scan job.')
        }
        return {
          state: entry.state,
          result: entry.result ?? null
        }
      }

      // -> Not in history yet: it may simply not have been picked up off the queue by any instance
      //    yet, which is not the same as not existing (see `Jobs#getPendingEntry`)
      const pending = await WIKI.models.jobs.getPendingEntry(req.params.jobId)
      if (!pending || pending.task !== 'scanPageProblems') {
        return reply.notFound('No such scan job.')
      }
      return { state: 'queued', result: null }
    }
  )
}

export default routes
