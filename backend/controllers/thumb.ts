import crypto from 'node:crypto'
import { guardSiteEnabled, isValidUuid } from '../helpers/common.ts'
import type { FastifyInstance } from 'fastify'

/**
 * How long a browser may keep a thumbnail before asking again.
 *
 * Short, and revalidated: unlike the old `public, immutable` directive this replaced, the reply now
 * depends on who asked and which site's rules apply — a shared cache holding one reader's copy of a
 * private site's thumbnail would hand it to the next reader along, the same reasoning `files.ts`'s
 * `FILE_CACHE` documents for `/_files/`. The bytes themselves are still fixed once generated (an
 * asset that changes gets a new ID), so `must-revalidate` costs a 304 round trip, not a re-fetch.
 */
const THUMB_CACHE = 'private, max-age=600, must-revalidate'

/**
 * _thumb Routes
 *
 * A thumbnail is a shrunken copy of an asset served the same access-controlled way `/_files/` serves
 * the original — so an asset UUID is treated as no more protective than knowing a `/_files/` path:
 * either can survive in a shared link, browser history, a screenshot, or a page that legitimately
 * embedded it before the rules changed. Every request is resolved to the site behind the requesting
 * hostname, refused if the id belongs to a different site, and judged against `read:assets` for the
 * path it names — matching `controllers/files.ts` exactly. A denial answers the same 404 as "no such
 * asset" or "no thumbnail", so the endpoint cannot be probed for existence either way.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { fileName: string } }>('/:fileName', async (req, reply) => {
    // -> `.webp` is part of the URL so that the extension matches what is served, but the ID is the
    //    only part that identifies anything
    const assetId = req.params.fileName.replace(/\.webp$/i, '')
    if (!isValidUuid(assetId)) {
      return reply.notFound('Thumbnail not found')
    }

    const thumbnail = await WIKI.models.assets.getThumbnail(assetId)
    if (!thumbnail) {
      return reply.notFound('Thumbnail not found')
    }

    const site = await WIKI.models.sites.getSiteByHostname({ hostname: req.hostname })
    // -> Not found rather than forbidden: a mismatched site is indistinguishable from no asset at all
    if (!site || thumbnail.siteId !== site.id) {
      return reply.notFound('Thumbnail not found')
    }
    if (guardSiteEnabled(site, reply)) {
      return
    }

    if (
      !WIKI.models.groups.checkAccess(WIKI.models.groups.actorForRequest(req), 'read:assets', {
        path: thumbnail.folderPath
          ? `${thumbnail.folderPath}/${thumbnail.fileName}`
          : thumbnail.fileName,
        siteId: site.id,
        locale: thumbnail.locale,
        // -> An asset carries no classification of its own — same treatment as `mayOnAsset` in
        //    `api/assets.ts` and the `/_files/` route above it.
        classification: null
      })
    ) {
      return reply.notFound('Thumbnail not found')
    }

    const etag = `"${crypto.createHash('sha1').update(thumbnail.preview).digest('hex')}"`
    reply.header('ETag', etag)
    reply.header('Cache-Control', THUMB_CACHE)
    reply.header('X-Content-Type-Options', 'nosniff')
    if (req.headers['if-none-match'] === etag) {
      return reply.code(304).send()
    }

    return reply.type('image/webp').send(thumbnail.preview)
  })
}

export default routes
