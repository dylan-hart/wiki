import { dispositionFor } from '../models/assets.ts'
import { mayOnAsset } from '../helpers/pageAccess.ts'
import { enforceApiKeySite } from '../helpers/apiKeySite.ts'
import { guardSiteEnabled } from '../helpers/siteResolution.ts'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import { needsSvgCsp, SVG_CSP } from '../helpers/security.ts'
import type { FastifyInstance } from 'fastify'

/**
 * Short, and revalidated: unlike a thumbnail, what sits at a path is not fixed — deleting a file and
 * uploading another under the same name puts different bytes behind the same URL. `private`, because
 * the reply depends on who asked: a shared cache would hand one reader's copy to the next.
 */
const FILE_CACHE = 'private, max-age=600, must-revalidate'

/**
 * How a page's content points at an uploaded file: `/_files/<folder>/<name.ext>`. Addressed by path
 * rather than by ID so that what an author reads in their own markdown is the file they picked, and
 * so that content carries nothing instance-specific. The cost: renaming or moving a file leaves the
 * pages that pointed at it pointing at nothing.
 *
 * No session is required, but every request is judged against `read:assets` for the path it asked
 * for.
 *
 * Every image on every page comes through here, so neither half of the lookup normally reaches the
 * database: the path resolves out of memory and the bytes stream off the local disk cache.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { '*': string } }>('/*', async (req, reply) => {
    const site = await CARDINAL.models.sites.getSiteByHostname({ hostname: req.hostname })
    if (!site) {
      return reply.notFound('Site not found')
    }
    // -> Resolved by `req.hostname` rather than a `:siteId` route param, so `apiKeySitePinHook` never
    //    sees this route -- a site-pinned key could otherwise read another site's files by hostname
    if (!enforceApiKeySite(req, reply, site.id)) {
      return
    }
    // -> The page/shell hook's disabled-site check does not cover this route either
    if (guardSiteEnabled(site, reply)) {
      return reply
    }

    const asset = await CARDINAL.models.assetServing.resolveAssetPath(
      site.id,
      req.params['*'] ?? ''
    )
    // -> Not readable is answered as not there, so the URL cannot be used to probe for files
    if (!asset || !mayOnAsset(req, 'read:assets', site.id, asset)) {
      return reply.notFound('File not found')
    }

    /*
      The ID and the timestamp together, because either one alone lies: a file replaced at the same
      path is a different asset under the same URL, and one edited in place keeps its ID.
    */
    // -> `notModifiedOrPrepare` also sends `nosniff`: the bytes came from a user, so the browser must
    //    take the type at its word
    const etag = `"${asset.id}-${asset.updatedAt.getTime()}"`
    if (notModifiedOrPrepare(req, reply, { etag, cacheControl: FILE_CACHE })) {
      return reply
    }

    const content = await CARDINAL.models.assetServing.readContent(asset, site.id)
    if (!content) {
      // -> The path resolved to a row that is no longer there, so the resolution was a stale one
      CARDINAL.models.assetServing.forgetPath(site.id, asset.folderPath, asset.fileName)
      return reply.notFound('File not found')
    }
    if ('redirectUrl' in content) {
      return reply.redirect(content.redirectUrl, 302)
    }

    if (dispositionFor(asset.fileExt)) {
      reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(asset.fileName)}"`
      )
    }
    // -> Neutralizes an SVG or HTML/XHTML file opened as a document rather than embedded
    if (needsSvgCsp(asset.fileExt)) {
      reply.header('Content-Security-Policy', SVG_CSP)
    }
    // -> Set by hand because the body may be a stream, which Fastify would otherwise send chunked —
    //    and a download with no length is a download with no progress bar
    reply.header('Content-Length', content.size)
    return reply.type(asset.mimeType).send(content.body)
  })
}

export default routes
