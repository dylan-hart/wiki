import type { FastifyInstance } from 'fastify'
import fastifyMultipart from '@fastify/multipart'

import { decodeTreePath, normalizePagePath } from '../helpers/common.ts'
import { needsSvgCsp, SVG_CSP } from '../helpers/security.ts'
import { dispositionFor } from '../models/assets.ts'
import { actorFrom, mayOnAsset } from '../helpers/pageAccess.ts'
import { limitUploads } from '../helpers/rateLimit.ts'

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

/**
 * Assets API Routes
 */
async function routes(app: FastifyInstance) {
  // -> An upload is the raw file rather than a multipart form: one file per request, with the name and
  //    the destination in the query string. The catch-all only claims content types nothing else
  //    parses, so the JSON routes below are unaffected.
  //
  //    The limit is read once, here, because a route's body limit is fixed when it is registered —
  //    changing it in the admin area takes effect on the next restart, as the rest of the security
  //    settings do.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: WIKI.config.security?.uploadMaxFileSize ?? 10485760 },
    (req, body, done) => {
      done(null, body)
    }
  )

  // -> UPLOAD ASSETS (BATCH)'s body carries several files in one request, which the raw-bytes
  //    approach above has no room for — `@fastify/multipart` claims `multipart/form-data`
  //    specifically, which Fastify matches ahead of the generic `'*'` parser above regardless of
  //    registration order (`api/pages/import.ts` is the existing precedent for this exact
  //    combination, in the same one-plugin-scope shape). `files` is the admin-configurable
  //    per-request file-count cap (OpenProject #3211/#3231) — framed as resource-exhaustion
  //    protection, not a user upload quota: the same total file count is already reachable by
  //    looping the single-file route above. Exceeding it trips `@fastify/multipart`'s own
  //    `filesLimit` event while iterating `req.parts()` below (a `FST_FILES_LIMIT` error, 413),
  //    i.e. before the over-the-limit file's bytes are ever read into memory — the batch route
  //    below lets that surface as-is rather than re-deriving the count itself.
  //    `throwFileSizeLimit: false` (mirroring `pages/import.ts`'s OpenProject #849 fix): the default
  //    `true` would fail the WHOLE batch the moment one file exceeds `uploadMaxFileSize`, even
  //    though every file after it in the batch would otherwise upload fine — the route below reads
  //    `part.file.truncated` itself instead of trusting `toBuffer()` to throw.
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: WIKI.config.security?.uploadMaxFileSize ?? 10485760,
      files: WIKI.config.security?.uploadMaxFilesPerBatch ?? 10
    },
    throwFileSizeLimit: false
  })

  /**
   * UPLOAD ASSET
   */
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
      // -> A tighter, upload-specific limit than the generic per-caller `/_api/*` ceiling -- once a
      //    multi-file selection goes through the batch endpoint instead, a rapid burst of single-file
      //    requests here is the signature of a caller working around that endpoint's own file-count
      //    cap, not real single-upload usage. See `helpers/rateLimit.ts#limitUploads` (OpenProject
      //    #3234).
      preHandler: limitUploads,
      schema: {
        summary: 'Upload an asset',
        description: `The body is the file itself, not a multipart form — send the bytes with their \`Content-Type\`. At most ${Math.round((WIKI.config.security?.uploadMaxFileSize ?? 10485760) / 1024 / 1024)} MB. The file name is sanitized, so the stored name in the response may differ from the one sent; the type served back later comes from that name's extension rather than from the request. Images get a thumbnail when the Sharp extension is installed.\n\nA file already at that name in that folder is settled by the site's upload conflict behavior: \`overwrite\` (the default) replaces it in place and answers with its existing ID, \`reject\` answers 409, and \`new\` stores the arrival as the next free \`name-1.ext\`. So the name and ID in the response are what to link to — never the ones that were sent. A page or a folder holding the name is answered 409 whichever behavior is set.`,
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
        req.query.locale ?? WIKI.sites[req.params.siteId]?.config?.locales?.primary ?? 'en'

      /*
        `folderId` wins when given, exactly as it did before `parentPath` existed. Otherwise
        `parentPath` names the destination as a page's own folder does — resolved (and created, along
        with any missing ancestor) below, but only once the permission check against that path has
        passed, so an unprivileged upload never has the side effect of creating a folder it wasn't
        allowed to write into.

        `parentPath` is normalized the same way a page path is (`normalizePagePath`) before it is
        used for anything: `getFolder`/`createFolder` resolve and create against the lowercased,
        trimmed form regardless (`encodeTreePath`), so checking the permission against the raw,
        as-sent string would check a different path than the one the folder actually gets created
        at — a page rule written (as every page path is) in normalized form could then be bypassed
        just by sending `parentPath` with different casing or stray slashes.
      */
      // -> Scoped by siteId (OpenProject #2127): a caller-supplied folderId belonging to another
      //    site must resolve to nothing here, the same as an unknown id, rather than leaking that
      //    other site's folder path/locale into the permission check below.
      const folder = req.query.folderId
        ? await WIKI.models.tree.getFolderById(req.query.folderId, req.params.siteId)
        : null
      // -> Only a resolved-but-wrong-site folder is refused outright (matches tree.ts's own folder
      //    routes: GET/RENAME/DELETE FOLDER) -- `getFolderById` is itself already siteId-scoped in
      //    SQL, so a genuinely unresolvable id (unknown, or belonging to another site) comes back as
      //    a bare `null` in real use, and OpenProject #2131 wants that treated as "no folder to
      //    attach to" rather than a hard 404: the upload still proceeds, just without a `folderId`,
      //    the same as an empty `parentPath` uploads to the site root. This check exists purely as
      //    defense-in-depth against a `getFolderById` that (bug, or a future caller) hands back a
      //    row for the wrong site -- that row must never reach the permission check below or
      //    `upload()`'s `folderId`.
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

      // -> `folder`, not the raw `req.query.folderId`: a caller-supplied id that resolved to
      //    nothing (unknown, or scoped away by the site check above) must not reach `upload()` as
      //    a parent, which would otherwise attach the new asset's tree row to a folder belonging
      //    to a different site than the asset's own `siteId`.
      const folderId = req.query.folderId
        ? folder?.id
        : parentPath
          ? (
              await WIKI.models.tree.getFolder({
                path: parentPath,
                locale,
                siteId: req.params.siteId,
                createIfMissing: true
              })
            ).id
          : undefined

      const asset = await WIKI.models.assets.upload({
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

  /**
   * UPLOAD ASSETS (BATCH)
   */
  app.post<{
    Params: { siteId: string }
    Querystring: { folderId?: string; parentPath?: string; locale?: string }
  }>(
    '/sites/:siteId/assets/batch',
    {
      /*
        No route-level `permissions`: same reasoning as UPLOAD ASSET above — asset permissions come
        from a group's RULES, which address the folder AND file name a file is going into, so the
        check has to run once per file below rather than once for the whole batch (a rule can be
        written to match a specific file name pattern).
      */
      schema: {
        summary: 'Upload several assets in one request',
        description: `A \`multipart/form-data\` sibling of \`POST .../assets\` (OpenProject #3211): several files in one request (field name \`files\`, repeated), all uploaded to the same destination folder — \`folderId\`/\`parentPath\`/\`locale\` are shared by the whole batch, same meaning as the single-file route's own query parameters. At most ${WIKI.config.security?.uploadMaxFilesPerBatch ?? 10} files per request (admin-configurable), enforced by the multipart parser itself at parse time, before a file over that count is ever read into memory — exceeding it answers 413 for the whole request rather than a partial result. Each file is still individually capped at ${Math.round((WIKI.config.security?.uploadMaxFileSize ?? 10485760) / 1024 / 1024)} MB, same limit the single-file route enforces. The response carries one result per file, in the order they were sent — a bad file in the batch (an oversized file, a denied permission, a naming conflict) fails only its own entry, so check each entry's own \`ok\`.`,
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
      // -> An asset records who uploaded it, and an API key is not a who — same rule as the
      //    single-file route above.
      const authorId = req.session?.authenticated ? req.session.user?.id : null
      if (!authorId) {
        return reply.unauthorized('Uploading an asset requires a logged in user.')
      }

      const locale =
        req.query.locale ?? WIKI.sites[req.params.siteId]?.config?.locales?.primary ?? 'en'

      // -> Same destination resolution as UPLOAD ASSET above, run once for the whole batch: every
      //    file in a batch shares one folder, and `folderId`'s siteId scoping (OpenProject #2127) is
      //    exactly as load-bearing here as it is there.
      const folder = req.query.folderId
        ? await WIKI.models.tree.getFolderById(req.query.folderId, req.params.siteId)
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

      // -> Resolved (and created, along with any missing ancestor) at most once for the whole batch,
      //    lazily — only once the first file's own permission check has passed, so a batch with
      //    every file denied never has the side effect of creating a folder nothing was allowed to
      //    write into. Every file in the batch shares this same destination, so one resolution
      //    covers all of them.
      let resolvedFolderId: string | undefined
      let folderIdResolved = false
      async function destinationFolderId(): Promise<string | undefined> {
        if (!folderIdResolved) {
          folderIdResolved = true
          resolvedFolderId = req.query.folderId
            ? folder?.id
            : parentPath
              ? (
                  await WIKI.models.tree.getFolder({
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
              message: `This file is larger than the ${Math.round((WIKI.config.security?.uploadMaxFileSize ?? 10485760) / 1024 / 1024)} MB upload limit.`
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
            const asset = await WIKI.models.assets.upload({
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
        // -> The one whole-request failure mode: too many files in this batch, refused by
        //    `@fastify/multipart` itself at parse time (see the plugin registration comment above).
        //    Two distinct errors surface it, depending on timing: cleanly as `FST_FILES_LIMIT` when
        //    the over-the-limit file's part is reached between two `req.parts()` steps, but as
        //    Node's own `ERR_STREAM_PREMATURE_CLOSE` when it is reached WHILE a file already inside
        //    the limit is still being buffered -- `@fastify/multipart`'s own `cleanup()` destroys
        //    the in-flight file stream as part of enforcing the limit (`currentFile.destroy()`,
        //    `index.js`), which aborts that still-in-progress `toBuffer()` with a bare stream error
        //    carrying no reference back to the `FilesLimitError` that caused it. A small batch sent
        //    in one TCP write is exactly when this race is reachable — confirmed directly against a
        //    real listening server, not just `inject()`. Both are treated identically here: neither
        //    reaches this branch except from a request this plugin's own `limits` aborted.
        if (err.code === 'FST_FILES_LIMIT' || err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
          return reply.code(413).send({
            ok: false,
            statusCode: 413,
            error: 'Payload Too Large',
            message: `This batch has more files than the ${WIKI.config.security?.uploadMaxFilesPerBatch ?? 10} file limit for one request.`
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

  /**
   * GET ASSET
   */
  app.get<{ Params: { siteId: string; assetId: string } }>(
    '/sites/:siteId/assets/:assetId',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and asset permissions come
        from a group's RULES, which address the folder the file is in. Checked below.
      */
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
      const asset = await WIKI.models.assets.getAsset(req.params.siteId, req.params.assetId)
      // -> Not readable is answered as not there, so the endpoint cannot be used to probe for files
      if (!asset || !mayOnAsset(req, 'read:assets', req.params.siteId, asset)) {
        return reply.notFound('This asset does not exist.')
      }
      return asset
    }
  )

  /**
   * DOWNLOAD ASSET
   */
  app.get<{ Params: { siteId: string; assetId: string } }>(
    '/sites/:siteId/assets/:assetId/content',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and asset permissions come
        from a group's RULES, which address the folder the file is in. Checked below.
      */
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
      const asset = await WIKI.models.assets.getAsset(req.params.siteId, req.params.assetId)
      if (!asset || !mayOnAsset(req, 'read:assets', req.params.siteId, asset)) {
        return reply.notFound('This asset does not exist.')
      }
      // -> Through the same local disk cache `/_files/` serves from, since this is the download
      //    button in the file manager rather than an administrative route: anyone who may read a
      //    file may press it
      const content = await WIKI.models.assetServing.readContent(asset, req.params.siteId)
      if (!content) {
        return reply.notFound('This asset has no content.')
      }
      if ('redirectUrl' in content) {
        return reply.redirect(content.redirectUrl, 302)
      }

      // -> Same unified predicate `/_files/*` uses (`models/assets.ts#dispositionFor`) — this route
      //    used to invert it (`forceAssetDownload || !INLINE_EXTS.has(ext)`), which forced every
      //    image to download whenever `forceAssetDownload` was on, the shipped default (OpenProject
      //    #1360/#2152/#2164, 2026-08-24 security audit §3).
      if (dispositionFor(asset.fileExt)) {
        reply.header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(asset.fileName)}"`
        )
      }
      // -> Neutralizes an SVG or HTML/XHTML file opened as a document rather than embedded — see
      //    `helpers/security.ts`'s `SVG_CSP` for the full reasoning. Reachable whenever
      //    `forceAssetDownload` is off, which is what would otherwise leave this route serving one
      //    inline with no CSP at all.
      if (needsSvgCsp(asset.fileExt)) {
        reply.header('Content-Security-Policy', SVG_CSP)
      }
      // -> The bytes came from a user, so the browser must take the type at its word rather than
      //    looking for something more interesting in them
      reply.header('X-Content-Type-Options', 'nosniff')
      // -> Set by hand because the body may be a stream, which Fastify would otherwise send chunked
      reply.header('Content-Length', content.size)
      return reply.type(asset.mimeType).send(content.body)
    }
  )

  /**
   * RENAME ASSET
   */
  app.patch<{ Params: { siteId: string; assetId: string }; Body: { fileName: string } }>(
    '/sites/:siteId/assets/:assetId',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and asset permissions come
        from a group's RULES, which address the folder the file is in. Checked below.
      */
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
      const existing = await WIKI.models.assets.getAsset(req.params.siteId, req.params.assetId)
      if (!existing) {
        return reply.notFound('This asset does not exist.')
      }
      if (!mayOnAsset(req, 'manage:assets', req.params.siteId, existing)) {
        return reply.forbidden('You are not allowed to rename this file.')
      }
      const asset = await WIKI.models.assets.renameAsset(
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

  /**
   * MOVE ASSET
   */
  app.put<{
    Params: { siteId: string; assetId: string }
    Body: { folderId?: string; parentPath?: string }
  }>(
    '/sites/:siteId/assets/:assetId/folder',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and asset permissions come
        from a group's RULES, which address the folder the file is in. Checked below.
      */
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
      const existing = await WIKI.models.assets.getAsset(req.params.siteId, req.params.assetId)
      if (!existing) {
        return reply.notFound('This asset does not exist.')
      }
      if (!mayOnAsset(req, 'manage:assets', req.params.siteId, existing)) {
        return reply.forbidden('You are not allowed to move this file.')
      }

      // -> Scoped by siteId, same as upload's own folderId resolution -- a foreign or unknown
      //    folderId must 404 outright here, not fall back to the site root: a move's destination is
      //    explicit user intent, unlike upload's OpenProject #2131 leniency for a merely-suggested
      //    parent.
      const destinationFolder = req.body.folderId
        ? await WIKI.models.tree.getFolderById(req.body.folderId, req.params.siteId)
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

      const asset = await WIKI.models.assets.moveAsset({
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

  /**
   * DELETE ASSET
   */
  app.delete<{ Params: { siteId: string; assetId: string } }>(
    '/sites/:siteId/assets/:assetId',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and asset permissions come
        from a group's RULES, which address the folder the file is in. Checked below.
      */
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
      const doomed = await WIKI.models.assets.getAsset(req.params.siteId, req.params.assetId)
      if (!doomed) {
        return reply.notFound('This asset does not exist.')
      }
      if (!mayOnAsset(req, 'manage:assets', req.params.siteId, doomed)) {
        return reply.forbidden('You are not allowed to delete this file.')
      }
      if (
        !(await WIKI.models.assets.deleteAsset(req.params.siteId, req.params.assetId, {
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
