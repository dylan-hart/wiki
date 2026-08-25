import crypto from 'node:crypto'
import { guardSiteEnabled, isValidUuid } from '../helpers/common.ts'
import type { FastifyInstance } from 'fastify'

/**
 * A thumbnail is generated once, at upload time, and an asset that changes gets a new ID — so the
 * bytes behind a given URL never change once a caller is actually allowed to see them.
 *
 * `private` (OpenProject #2178), matching `controllers/files.ts`'s `FILE_CACHE`: the reply now
 * depends on who asked and which site's hostname they asked from, so a shared cache is not allowed
 * to hold one reader's copy for the next reader along — even though the bytes for a given id never
 * change, WHO may see them can, on a rules tightening or a group removal.
 */
const THUMB_CACHE = 'private, max-age=31536000, immutable'

/**
 * _thumb Routes
 *
 * A thumbnail is a shrunken copy of an asset already served elsewhere on the pages that embed it —
 * but, like `/_files/`, it is still access-controlled: the id in the URL is unguessable (a v4 UUID),
 * not a substitute for a permission check. Only assets that have a preview answer here — everything
 * else, including every non-image, is a 404 the file manager draws a file type icon for.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { fileName: string } }>('/:fileName', async (req, reply) => {
    // -> `.webp` is part of the URL so that the extension matches what is served, but the ID is the
    //    only part that identifies anything
    const assetId = req.params.fileName.replace(/\.webp$/i, '')
    if (!isValidUuid(assetId)) {
      return reply.notFound('Thumbnail not found')
    }

    const asset = await WIKI.models.assets.getThumbnailForServing(assetId)
    if (!asset) {
      return reply.notFound('Thumbnail not found')
    }

    // -> Resolved by hostname, same as `/_files/`: on a multi-site instance, a hostname that does
    //    not own this asset must not be able to serve it.
    const site = await WIKI.models.sites.getSiteByHostname({ hostname: req.hostname })
    if (!site || site.id !== asset.siteId) {
      return reply.notFound('Thumbnail not found')
    }
    if (guardSiteEnabled(site, reply)) {
      return
    }

    if (
      !WIKI.models.groups.checkAccess(WIKI.models.groups.actorForRequest(req), 'read:assets', {
        path: asset.folderPath ? `${asset.folderPath}/${asset.fileName}` : asset.fileName,
        siteId: site.id,
        locale: asset.locale,
        // -> An asset carries no classification of its own -- same treatment as `/_files/`
        classification: null
      })
    ) {
      // -> Refused as not-found, not forbidden, so the endpoint still cannot be probed for
      //    existence -- same reasoning as `/_files/`'s own `read:assets` gate.
      return reply.notFound('Thumbnail not found')
    }

    const etag = `"${crypto.createHash('sha1').update(asset.preview).digest('hex')}"`
    reply.header('ETag', etag)
    reply.header('Cache-Control', THUMB_CACHE)
    reply.header('X-Content-Type-Options', 'nosniff')
    if (req.headers['if-none-match'] === etag) {
      return reply.code(304).send()
    }

    return reply.type('image/webp').send(asset.preview)
  })
}

export default routes
