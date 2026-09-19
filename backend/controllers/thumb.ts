import crypto from 'node:crypto'
import { isValidUuid } from '../helpers/common.ts'
import { guardSiteEnabled } from '../helpers/siteResolution.ts'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import { mayOnAsset } from '../helpers/pageAccess.ts'
import type { FastifyInstance } from 'fastify'

/**
 * `private` and revalidated because the reply depends on who asked: a shared cache would hand one
 * reader's copy to the next. The bytes are fixed once generated (a changed asset gets a new ID), so
 * revalidating costs a 304, not a re-fetch.
 */
const THUMB_CACHE = 'private, max-age=600, must-revalidate'

/**
 * An asset UUID is no more secret than a `/_files/` path (shared links, browser history, stale
 * embeds), so a thumbnail is access-controlled the way `controllers/files.ts` serves the original.
 * A denial or a site mismatch answers the same 404 as a missing thumbnail, so the endpoint cannot
 * be probed for existence.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { fileName: string } }>('/:fileName', async (req, reply) => {
    // -> `.webp` is part of the URL so that the extension matches what is served, but the ID is the
    //    only part that identifies anything
    const assetId = req.params.fileName.replace(/\.webp$/i, '')
    if (!isValidUuid(assetId)) {
      return reply.notFound('Thumbnail not found')
    }

    const thumbnail = await CARDINAL.models.assets.getThumbnail(assetId)
    if (!thumbnail) {
      return reply.notFound('Thumbnail not found')
    }

    const site = await CARDINAL.models.sites.getSiteByHostname({ hostname: req.hostname })
    if (!site || thumbnail.siteId !== site.id) {
      return reply.notFound('Thumbnail not found')
    }
    if (guardSiteEnabled(site, reply)) {
      return reply
    }

    if (!mayOnAsset(req, 'read:assets', site.id, thumbnail)) {
      return reply.notFound('Thumbnail not found')
    }

    const etag = `"${crypto.createHash('sha1').update(thumbnail.preview).digest('hex')}"`
    if (notModifiedOrPrepare(req, reply, { etag, cacheControl: THUMB_CACHE })) {
      return reply
    }

    return reply.type('image/webp').send(thumbnail.preview)
  })
}

export default routes
