import type { FastifyInstance, FastifyRequest } from 'fastify'

import { decodeTreePath, guardSiteEnabled, normalizePagePath } from '../helpers/common.ts'
import { INLINE_EXTS } from '../models/assets.ts'

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
/**
 * Whether the caller holds an asset permission on an asset, judged on where it sits.
 *
 * Assets live in the same tree as pages and are addressed by the same rules — a rule over a branch
 * covers the files in it as well as the pages, which is why the asset permissions are offered
 * alongside the page ones in the group editor.
 */
export function mayOnAsset(
  req: FastifyRequest,
  permission: string,
  siteId: string,
  asset: { folderPath?: string | null; fileName: string; locale: string }
): boolean {
  const folder = asset.folderPath ?? ''
  return WIKI.models.groups.checkAccess(WIKI.models.groups.actorForRequest(req), permission, {
    path: folder ? `${folder}/${asset.fileName}` : asset.fileName,
    siteId,
    locale: asset.locale
  })
}

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
      schema: {
        summary: 'Upload an asset',
        description: `The body is the file itself, not a multipart form — send the bytes with their \`Content-Type\`. At most ${Math.round((WIKI.config.security?.uploadMaxFileSize ?? 10485760) / 1024 / 1024)} MB. The file name is sanitized, so the stored name in the response may differ from the one sent; the type served back later comes from that name's extension rather than from the request. Images get a thumbnail when the Sharp extension is installed.\n\nA file already at that name in that folder is settled by the site's upload conflict behavior: \`overwrite\` (the default) replaces it in place and answers with its existing ID, \`reject\` answers 409, and \`new\` stores the arrival as the next free \`name-1.ext\`. So the name and ID in the response are what to link to — never the ones that were sent. A page or a folder holding the name is answered 409 whichever behavior is set.`,
        tags: ['Assets'],
        consumes: ['*/*'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId']
        },
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
      const folder = req.query.folderId
        ? await WIKI.models.tree.getFolderById(req.query.folderId)
        : null
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

      const folderId = req.query.folderId
        ? req.query.folderId
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
      if (guardSiteEnabled(WIKI.sites[req.params.siteId], reply)) {
        return
      }
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
      if (guardSiteEnabled(WIKI.sites[req.params.siteId], reply)) {
        return
      }
      const asset = await WIKI.models.assets.getAsset(req.params.siteId, req.params.assetId)
      if (!asset || !mayOnAsset(req, 'read:assets', req.params.siteId, asset)) {
        return reply.notFound('This asset does not exist.')
      }
      // -> Through the same local disk cache `/_files/` serves from, since this is the download
      //    button in the file manager rather than an administrative route: anyone who may read a
      //    file may press it
      const content = await WIKI.models.assets.readContent(asset, req.params.siteId)
      if (!content) {
        return reply.notFound('This asset has no content.')
      }
      if ('redirectUrl' in content) {
        return reply.redirect(content.redirectUrl, 302)
      }

      if (WIKI.config.security?.forceAssetDownload || !INLINE_EXTS.has(asset.fileExt)) {
        reply.header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(asset.fileName)}"`
        )
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
      if (!(await WIKI.models.assets.deleteAsset(req.params.siteId, req.params.assetId))) {
        return reply.notFound('This asset does not exist.')
      }
      return reply.code(204).send()
    }
  )
}

export default routes
