import type { FastifyInstance } from 'fastify'
import fastifyMultipart from '@fastify/multipart'

import { decodeTreePath, normalizePagePath } from '../helpers/common.ts'
import { needsSvgCsp, SVG_CSP } from '../helpers/security.ts'
import { dispositionFor } from '../models/assets.ts'
import { actorFrom, mayOnAsset } from '../helpers/pageAccess.ts'
import { limitUploads } from '../helpers/rateLimit.ts'
import { searchAssets } from '../modules/search/db/assetSearch.ts'

const assetIdParam = {
  type: 'object',
  properties: {
    siteId: {
      type: 'string',
      format: 'uuid'
    },
    assetId: {
      type: 'string',
      format: 'uuid'
    }
  },
  required: ['siteId', 'assetId']
}

async function routes(app: FastifyInstance) {
  // -> An upload is the raw file rather than a multipart form. The catch-all only claims content
  //    types nothing else parses, so the JSON routes below are unaffected. A body limit is fixed at
  //    registration, so changing it in the admin area takes a restart.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: CARDINAL.config.security?.uploadMaxFileSize ?? 10485760 },
    (req, body, done) => {
      done(null, body)
    }
  )

  // -> The batch route carries several files per request, which the raw-bytes parser above has no
  //    room for. Fastify matches `multipart/form-data` ahead of the `'*'` parser regardless of
  //    registration order. `throwFileSizeLimit: false` because the default fails the whole batch on
  //    one oversized file; the batch route reads `part.file.truncated` instead.
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: CARDINAL.config.security?.uploadMaxFileSize ?? 10485760,
      files: CARDINAL.config.security?.uploadMaxFilesPerBatch ?? 10
    },
    throwFileSizeLimit: false
  })

  app.post<{
    Params: { siteId: string }
    Querystring: { fileName: string; folderId?: string; parentPath?: string; locale?: string }
  }>(
    '/sites/:siteId/assets',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and asset permissions come
        from a group's RULES, which address the folder the file is in. Checked below.
      */
      // -> Tighter than the generic per-caller `/_api/*` ceiling: a rapid burst of single-file
      //    requests is the signature of a caller working around the batch route's file-count cap.
      preHandler: limitUploads,
      schema: {
        summary: 'Upload an asset',
        description: `The body is the file itself, not a multipart form — send the bytes with their \`Content-Type\`. At most ${Math.round((CARDINAL.config.security?.uploadMaxFileSize ?? 10485760) / 1024 / 1024)} MB. The file name is sanitized, so the stored name in the response may differ from the one sent; the type served back later comes from that name's extension rather than from the request. Images get a thumbnail when the Sharp extension is installed.\n\nA file already at that name in that folder is settled by the site's upload conflict behavior: \`overwrite\` (the default) replaces it in place and answers with its existing ID, \`reject\` answers 409, and \`new\` stores the arrival as the next free \`name-1.ext\`. So the name and ID in the response are what to link to — never the ones that were sent. A page or a folder holding the name is answered 409 whichever behavior is set.`,
        tags: ['Assets'],
        consumes: ['*/*'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            fileName: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            },
            folderId: {
              type: 'string',
              format: 'uuid',
              description: 'The folder to upload into. Wins over `parentPath`.'
            },
            parentPath: {
              type: 'string',
              maxLength: 2048,
              description:
                'Slash-separated path of the folder to upload into, created (with any missing ancestor) if it does not exist yet. The site root when absent, same as an empty string.'
            },
            locale: {
              type: 'string',
              minLength: 1,
              maxLength: 10,
              description: "The site's primary locale when absent."
            }
          },
          required: ['fileName']
        },
        response: {
          200: {
            description: 'Asset uploaded successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              asset: { $ref: 'Asset#' }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            $ref: 'ApiError#',
            description:
              'A page or folder already holds this name, or a file does and the conflict behavior is `reject`.'
          }
        }
      }
    },
    async (req, reply) => {
      // -> An asset records who uploaded it, and an API key is not a who
      const authorId = req.session?.authenticated ? req.session.user?.id : null
      if (!authorId) {
        return reply.unauthorized('Uploading an asset requires a logged in user.')
      }
      const data = req.body
      if (!Buffer.isBuffer(data) || data.length < 1) {
        return reply.badRequest('No file was sent.')
      }

      const locale =
        req.query.locale ?? CARDINAL.sites[req.params.siteId]?.config?.locales?.primary ?? 'en'

      /*
        The `parentPath` folder is resolved (and created) only after the permission check passes, so
        a refused upload never creates a folder.

        `parentPath` is normalized like a page path first: `getFolder` resolves against the normalized
        form regardless, so checking the raw string would check a different path than the one
        created, and a rule could be bypassed with different casing or stray slashes.
      */
      // -> Scoped by siteId: another site's folderId resolves to nothing, like an unknown id,
      //    rather than leaking that site's folder path into the permission check below.
      const folder = req.query.folderId
        ? await CARDINAL.models.tree.getFolderById(req.query.folderId, req.params.siteId)
        : null
      // -> Defense-in-depth: `getFolderById` is siteId-scoped in SQL, so a wrong-site row should be
      //    impossible, but one must never reach the permission check or `upload()`. An unresolvable
      //    id (`null`) is deliberately not a 404: the upload proceeds without a folder, as an empty
      //    `parentPath` does.
      if (req.query.folderId && folder && folder.siteId !== req.params.siteId) {
        return reply.notFound('This folder does not exist.')
      }
      const folderPath = folder ? (decodeTreePath(folder.folderPath ?? '') ?? '') : ''
      const parentPath = req.query.parentPath ? normalizePagePath(req.query.parentPath) : ''
      const destination = req.query.folderId
        ? folder
          ? [folderPath, folder.fileName].filter(Boolean).join('/')
          : ''
        : parentPath
      if (
        !mayOnAsset(req, 'write:assets', req.params.siteId, {
          folderPath: destination,
          fileName: req.query.fileName,
          locale
        })
      ) {
        return reply.forbidden('You are not allowed to upload a file here.')
      }

      // -> `folder?.id`, not the raw `req.query.folderId`: an id that resolved to nothing must not
      //    reach `upload()` as a parent.
      const folderId = req.query.folderId
        ? folder?.id
        : parentPath
          ? (
              await CARDINAL.models.tree.getFolder({
                path: parentPath,
                locale,
                siteId: req.params.siteId,
                createIfMissing: true
              })
            ).id
          : undefined

      const asset = await CARDINAL.models.assets.upload({
        siteId: req.params.siteId,
        locale,
        folderId,
        fileName: req.query.fileName,
        mimeType: req.headers['content-type'],
        data,
        authorId
      })

      return {
        ok: true,
        message: 'Asset uploaded successfully.',
        asset
      }
    }
  )

  app.post<{
    Params: { siteId: string }
    Querystring: { folderId?: string; parentPath?: string; locale?: string }
  }>(
    '/sites/:siteId/assets/batch',
    {
      /*
        No route-level `permissions`: as for the upload route above. The check runs once per file
        rather than once per batch, since a rule can match on the file name.
      */
      schema: {
        summary: 'Upload several assets in one request',
        description: `A \`multipart/form-data\` sibling of \`POST .../assets\` (OpenProject #3211): several files in one request (field name \`files\`, repeated), all uploaded to the same destination folder — \`folderId\`/\`parentPath\`/\`locale\` are shared by the whole batch, same meaning as the single-file route's own query parameters. At most ${CARDINAL.config.security?.uploadMaxFilesPerBatch ?? 10} files per request (admin-configurable), enforced by the multipart parser itself at parse time, before a file over that count is ever read into memory — exceeding it answers 413 for the whole request rather than a partial result. Each file is still individually capped at ${Math.round((CARDINAL.config.security?.uploadMaxFileSize ?? 10485760) / 1024 / 1024)} MB, same limit the single-file route enforces. The response carries one result per file, in the order they were sent — a bad file in the batch (an oversized file, a denied permission, a naming conflict) fails only its own entry, so check each entry's own \`ok\`.`,
        tags: ['Assets'],
        consumes: ['multipart/form-data'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            folderId: {
              type: 'string',
              format: 'uuid',
              description: 'The folder to upload into. Wins over `parentPath`.'
            },
            parentPath: {
              type: 'string',
              maxLength: 2048,
              description:
                'Slash-separated path of the folder to upload into, created (with any missing ancestor) if it does not exist yet. The site root when absent, same as an empty string.'
            },
            locale: {
              type: 'string',
              minLength: 1,
              maxLength: 10,
              description: "The site's primary locale when absent."
            }
          }
        },
        response: {
          200: {
            description: 'One result per uploaded file',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              results: {
                type: 'array',
                items: { $ref: 'AssetBatchUploadItem#' }
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          413: {
            $ref: 'ApiError#',
            description: 'More files than `security.uploadMaxFilesPerBatch` allows in one request.'
          }
        }
      }
    },
    async (req, reply) => {
      // -> An asset records who uploaded it, and an API key is not a who
      const authorId = req.session?.authenticated ? req.session.user?.id : null
      if (!authorId) {
        return reply.unauthorized('Uploading an asset requires a logged in user.')
      }

      const locale =
        req.query.locale ?? CARDINAL.sites[req.params.siteId]?.config?.locales?.primary ?? 'en'

      // -> The upload route's destination resolution, run once: a batch shares one folder
      const folder = req.query.folderId
        ? await CARDINAL.models.tree.getFolderById(req.query.folderId, req.params.siteId)
        : null
      if (req.query.folderId && folder && folder.siteId !== req.params.siteId) {
        return reply.notFound('This folder does not exist.')
      }
      const folderPath = folder ? (decodeTreePath(folder.folderPath ?? '') ?? '') : ''
      const parentPath = req.query.parentPath ? normalizePagePath(req.query.parentPath) : ''
      const destination = req.query.folderId
        ? folder
          ? [folderPath, folder.fileName].filter(Boolean).join('/')
          : ''
        : parentPath

      // -> Resolved (and created) at most once, and only after a file's permission check has
      //    passed, so a fully denied batch never creates a folder.
      let resolvedFolderId: string | undefined
      let folderIdResolved = false
      async function destinationFolderId(): Promise<string | undefined> {
        if (!folderIdResolved) {
          folderIdResolved = true
          resolvedFolderId = req.query.folderId
            ? folder?.id
            : parentPath
              ? (
                  await CARDINAL.models.tree.getFolder({
                    path: parentPath,
                    locale,
                    siteId: req.params.siteId,
                    createIfMissing: true
                  })
                ).id
              : undefined
        }
        return resolvedFolderId
      }

      const results: { fileName: string; ok: boolean; message?: string; asset?: unknown }[] = []

      try {
        for await (const part of req.parts()) {
          if (part.type !== 'file') {
            continue
          }
          const data = await part.toBuffer()
          if (part.file.truncated) {
            results.push({
              fileName: part.filename,
              ok: false,
              message: `This file is larger than the ${Math.round((CARDINAL.config.security?.uploadMaxFileSize ?? 10485760) / 1024 / 1024)} MB upload limit.`
            })
            continue
          }
          if (data.length < 1) {
            results.push({ fileName: part.filename, ok: false, message: 'This file is empty.' })
            continue
          }
          if (
            !mayOnAsset(req, 'write:assets', req.params.siteId, {
              folderPath: destination,
              fileName: part.filename,
              locale
            })
          ) {
            results.push({
              fileName: part.filename,
              ok: false,
              message: 'You are not allowed to upload a file here.'
            })
            continue
          }
          try {
            const asset = await CARDINAL.models.assets.upload({
              siteId: req.params.siteId,
              locale,
              folderId: await destinationFolderId(),
              fileName: part.filename,
              mimeType: part.mimetype,
              data,
              authorId
            })
            results.push({ fileName: part.filename, ok: true, asset })
          } catch (err: any) {
            results.push({
              fileName: part.filename,
              ok: false,
              message: err.message || 'This file could not be uploaded.'
            })
          }
        }
      } catch (err: any) {
        // -> Too many files surfaces as one of two errors, depending on timing: `FST_FILES_LIMIT`
        //    when the over-the-limit part is reached between two `req.parts()` steps, or Node's
        //    `ERR_STREAM_PREMATURE_CLOSE` when it is reached while an earlier file is still being
        //    buffered, because `@fastify/multipart` destroys the in-flight file stream to enforce
        //    the limit. A small batch sent in one TCP write is when the second is reachable.
        if (err.code === 'FST_FILES_LIMIT' || err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
          return reply.code(413).send({
            ok: false,
            statusCode: 413,
            error: 'Payload Too Large',
            message: `This batch has more files than the ${CARDINAL.config.security?.uploadMaxFilesPerBatch ?? 10} file limit for one request.`
          })
        }
        throw err
      }

      if (results.length < 1) {
        return reply.badRequest('No files were sent.')
      }

      return {
        ok: true,
        message: `${results.filter((r) => r.ok).length} of ${results.length} file(s) uploaded successfully.`,
        results
      }
    }
  )

  app.get<{
    Params: { siteId: string }
    Querystring: {
      query: string
      kind?: 'document' | 'image' | 'other'
      offset?: number
      limit?: number
    }
  }>(
    '/sites/:siteId/assets/search',
    {
      schema: {
        summary: 'Search asset contents',
        description:
          "Postgres full-text search over the text extracted from the assets of a site, ranked by relevance. Only assets the caller may read (`read:assets` on the asset's path) are matched, so a hit is never returned for a file `GET /sites/:siteId/assets/:assetId` would refuse. Assets whose text has not been extracted, or has none, never match.\n\n`highlight` is an excerpt with the matched terms wrapped in `<b>`, and is the only field carrying markup — the excerpt is escaped before those are added.",
        tags: ['Assets'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              minLength: 1,
              maxLength: 2048,
              description: 'Free text. Understands quoted phrases, `or` and `-exclusions`.'
            },
            kind: {
              type: 'string',
              enum: ['document', 'image', 'other'],
              description: 'Only assets of this kind.'
            },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
          },
          required: ['query']
        },
        response: {
          200: {
            description: 'Matching assets, plus how many there are in total',
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    fileName: { type: 'string' },
                    fileExt: { type: 'string' },
                    kind: { type: 'string', enum: ['document', 'image', 'other'] },
                    mimeType: { type: 'string' },
                    fileSize: { type: 'integer' },
                    folderPath: { type: 'string' },
                    title: { type: 'string' },
                    locale: { type: 'string' },
                    hasPreview: { type: 'boolean' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                    relevancy: { type: 'number' },
                    highlight: {
                      type: ['string', 'null'],
                      description: 'Excerpt with matched terms in `<b>`, everything else escaped.'
                    }
                  }
                }
              },
              totalHits: {
                type: 'integer',
                description:
                  'How many assets match and are visible to you, ignoring `limit` and `offset`. Counted only from rows you may read. Exact up to the scan cap; beyond it a floor.'
              },
              totalHitsApproximate: {
                type: 'boolean',
                description:
                  '`true` when `totalHits` is a floor rather than exact: your rules dropped one or more matching rows.'
              }
            }
          }
        }
      }
    },
    async (req) => {
      return searchAssets({
        siteId: req.params.siteId,
        query: req.query.query,
        actor: CARDINAL.models.groups.actorForRequest(req),
        kind: req.query.kind,
        offset: req.query.offset,
        limit: req.query.limit
      })
    }
  )

  app.get<{ Params: { siteId: string; assetId: string } }>(
    '/sites/:siteId/assets/:assetId',
    {
      /* No route-level `permissions`: as for the upload route above. */
      schema: {
        summary: 'Get a single asset',
        description: 'Metadata only. `/content` serves the file itself.',
        tags: ['Assets'],
        params: assetIdParam,
        response: {
          200: { $ref: 'Asset#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const asset = await CARDINAL.models.assets.getAsset(req.params.siteId, req.params.assetId)
      // -> Not readable is answered as not there, so the endpoint cannot be used to probe for files
      if (!asset || !mayOnAsset(req, 'read:assets', req.params.siteId, asset)) {
        return reply.notFound('This asset does not exist.')
      }
      return asset
    }
  )

  app.get<{ Params: { siteId: string; assetId: string } }>(
    '/sites/:siteId/assets/:assetId/content',
    {
      /* No route-level `permissions`: as for the upload route above. */
      schema: {
        summary: 'Download an asset',
        description:
          'The file itself. Anything a browser should not render inline is sent as an attachment, and the type is always the one derived from the stored file name.',
        tags: ['Assets'],
        params: assetIdParam,
        response: {
          200: {
            description: 'The file',
            content: {
              '*/*': {
                schema: {
                  type: 'string',
                  format: 'binary'
                }
              }
            }
          },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const asset = await CARDINAL.models.assets.getAsset(req.params.siteId, req.params.assetId)
      if (!asset || !mayOnAsset(req, 'read:assets', req.params.siteId, asset)) {
        return reply.notFound('This asset does not exist.')
      }
      // -> Through the same local disk cache `/_files/` serves from: this is the file manager's
      //    download button, open to anyone who may read the file, not an administrative route
      const content = await CARDINAL.models.assetServing.readContent(asset, req.params.siteId)
      if (!content) {
        return reply.notFound('This asset has no content.')
      }
      if ('redirectUrl' in content) {
        return reply.redirect(content.redirectUrl, 302)
      }

      // -> The predicate `/_files/*` uses, so the two routes cannot disagree
      if (dispositionFor(asset.fileExt)) {
        reply.header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(asset.fileName)}"`
        )
      }
      // -> Neutralizes an SVG or HTML/XHTML file opened as a document rather than embedded — see
      //    `helpers/security.ts`'s `SVG_CSP`. An SVG is always served inline, and HTML is whenever
      //    `forceAssetDownload` is off.
      if (needsSvgCsp(asset.fileExt)) {
        reply.header('Content-Security-Policy', SVG_CSP)
      }
      // -> The bytes came from a user, so the browser must take the declared type at its word
      reply.header('X-Content-Type-Options', 'nosniff')
      // -> Set by hand because the body may be a stream, which Fastify would otherwise send chunked
      reply.header('Content-Length', content.size)
      return reply.type(asset.mimeType).send(content.body)
    }
  )

  app.patch<{ Params: { siteId: string; assetId: string }; Body: { fileName: string } }>(
    '/sites/:siteId/assets/:assetId',
    {
      /* No route-level `permissions`: as for the upload route above. */
      schema: {
        summary: 'Rename an asset',
        description:
          'The extension is part of the name, and changing it changes the type the file is served as.',
        tags: ['Assets'],
        params: assetIdParam,
        body: {
          type: 'object',
          required: ['fileName'],
          properties: {
            fileName: {
              type: 'string',
              minLength: 3,
              maxLength: 255,
              description: 'Sanitized, so the stored name may differ from the one sent.'
            }
          }
        },
        response: {
          200: {
            description: 'Asset renamed successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              asset: { $ref: 'Asset#' }
            }
          },
          400: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const existing = await CARDINAL.models.assets.getAsset(req.params.siteId, req.params.assetId)
      if (!existing) {
        return reply.notFound('This asset does not exist.')
      }
      if (!mayOnAsset(req, 'manage:assets', req.params.siteId, existing)) {
        return reply.forbidden('You are not allowed to rename this file.')
      }
      const asset = await CARDINAL.models.assets.renameAsset(
        req.params.siteId,
        req.params.assetId,
        req.body.fileName
      )
      if (!asset) {
        return reply.notFound('This asset does not exist.')
      }
      return {
        ok: true,
        message: 'Asset renamed successfully.',
        asset
      }
    }
  )

  app.put<{
    Params: { siteId: string; assetId: string }
    Body: { folderId?: string; parentPath?: string }
  }>(
    '/sites/:siteId/assets/:assetId/folder',
    {
      /* No route-level `permissions`: as for the upload route above. */
      schema: {
        summary: 'Move an asset to another folder',
        description:
          "Reparents the asset in place -- its name, contents and locale are untouched. `folderId` wins over `parentPath` when both are sent; neither given moves it to the site root. `parentPath` is created, along with any missing ancestor, the same way an upload's is.\n\nThe caller needs `manage:assets` on the asset's current folder AND `write:assets` on the destination -- the same source/destination split a page move checks (`manage:pages`/`write:pages`). A page, folder or another asset already holding the name at the destination answers 409.",
        tags: ['Assets'],
        params: assetIdParam,
        body: {
          type: 'object',
          properties: {
            folderId: {
              type: 'string',
              format: 'uuid',
              description: 'The destination folder. Wins over `parentPath`.'
            },
            parentPath: {
              type: 'string',
              maxLength: 2048,
              description:
                'Slash-separated path of the destination folder, created (with any missing ancestor) if it does not exist yet. The site root when both are absent, same as an empty string.'
            }
          }
        },
        response: {
          200: {
            description: 'Asset moved successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              asset: { $ref: 'Asset#' }
            }
          },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            $ref: 'ApiError#',
            description:
              'A page, folder or another asset already holds this name at the destination.'
          }
        }
      }
    },
    async (req, reply) => {
      const existing = await CARDINAL.models.assets.getAsset(req.params.siteId, req.params.assetId)
      if (!existing) {
        return reply.notFound('This asset does not exist.')
      }
      if (!mayOnAsset(req, 'manage:assets', req.params.siteId, existing)) {
        return reply.forbidden('You are not allowed to move this file.')
      }

      // -> Unlike upload, a foreign or unknown folderId is a 404 rather than a fall back to the
      //    site root: a move's destination is explicit intent, not a suggested parent.
      const destinationFolder = req.body.folderId
        ? await CARDINAL.models.tree.getFolderById(req.body.folderId, req.params.siteId)
        : null
      if (req.body.folderId && !destinationFolder) {
        return reply.notFound('This folder does not exist.')
      }
      const parentPath = req.body.folderId
        ? undefined
        : req.body.parentPath
          ? normalizePagePath(req.body.parentPath)
          : ''
      const destinationPath = destinationFolder
        ? [decodeTreePath(destinationFolder.folderPath ?? '') ?? '', destinationFolder.fileName]
            .filter(Boolean)
            .join('/')
        : parentPath

      if (
        !mayOnAsset(req, 'write:assets', req.params.siteId, {
          folderPath: destinationPath,
          fileName: existing.fileName,
          locale: existing.locale
        })
      ) {
        return reply.forbidden('You are not allowed to move a file here.')
      }

      const asset = await CARDINAL.models.assets.moveAsset({
        siteId: req.params.siteId,
        id: req.params.assetId,
        folderId: req.body.folderId,
        parentPath
      })
      if (!asset) {
        return reply.notFound('This asset does not exist.')
      }
      return {
        ok: true,
        message: 'Asset moved successfully.',
        asset
      }
    }
  )

  app.delete<{ Params: { siteId: string; assetId: string } }>(
    '/sites/:siteId/assets/:assetId',
    {
      /* No route-level `permissions`: as for the upload route above. */
      schema: {
        summary: 'Delete an asset',
        tags: ['Assets'],
        params: assetIdParam,
        response: {
          204: {
            description: 'Asset deleted successfully'
          },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const doomed = await CARDINAL.models.assets.getAsset(req.params.siteId, req.params.assetId)
      if (!doomed) {
        return reply.notFound('This asset does not exist.')
      }
      if (!mayOnAsset(req, 'manage:assets', req.params.siteId, doomed)) {
        return reply.forbidden('You are not allowed to delete this file.')
      }
      if (
        !(await CARDINAL.models.assets.deleteAsset(req.params.siteId, req.params.assetId, {
          authorId: actorFrom(req)?.id
        }))
      ) {
        return reply.notFound('This asset does not exist.')
      }
      return reply.code(204).send()
    }
  )
}

export default routes
