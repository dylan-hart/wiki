import { dispositionFor } from '../models/assets.ts'
import { mayOnAsset } from '../helpers/pageAccess.ts'
import { enforceApiKeySite } from '../helpers/apiKeySite.ts'
import { guardSiteEnabled } from '../helpers/siteResolution.ts'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import { needsSvgCsp, SVG_CSP } from '../helpers/security.ts'
import type { FastifyInstance } from 'fastify'

/**
 * How long a browser may keep a file before asking again.
 *
 * Short, and revalidated: unlike a thumbnail, what sits at a path is not fixed — deleting a file and
 * uploading another under the same name puts different bytes behind the same URL. `private`, because
 * the reply depends on who asked: a shared cache holding one reader's copy of a file the rules put
 * behind an account would hand it to the next reader along.
 */
const FILE_CACHE = 'private, max-age=600, must-revalidate'

/**
 * _files Routes
 *
 * How a page's content points at an uploaded file: `/_files/<folder>/<name.ext>`, which is the path
 * the file manager shows and what the editors write into a page.
 *
 * Addressed by path rather than by ID so that what an author reads in their own markdown is the file
 * they picked, and so that content carries nothing instance-specific. The cost is the other half of
 * that bargain: renaming or moving a file leaves the pages that pointed at it pointing at nothing.
 *
 * Public in the sense that `_site` and `_thumb` are — no session is required — but not unguarded:
 * assets are addressed by the same rules as the pages they sit among, so every request is judged
 * against `read:assets` for the path it asked for.
 *
 * Every image on every page comes through here, so neither half of the lookup normally reaches the
 * database: the path resolves out of memory and the bytes stream off the local disk cache. See the
 * assets model for what that caches and when it lets go of it.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { '*': string } }>('/*', async (req, reply) => {
    const site = await WIKI.models.sites.getSiteByHostname({ hostname: req.hostname })
    if (!site) {
      return reply.notFound('Site not found')
    }
    // -> Resolved by `req.hostname` rather than a `:siteId` route param, so the params-only site-pin
    //    hook (the sibling of this task, OpenProject #2194) never sees this route at all -- a
    //    site-scoped key could otherwise read another site's files just by asking on its hostname.
    if (!enforceApiKeySite(req, reply, site.id)) {
      return
    }
    // -> Resolved by hostname independently of the page/shell hook, so a disabled site's files stay
    //    reachable by direct URL until this stops them the same way
    if (guardSiteEnabled(site, reply)) {
      return reply
    }

    const asset = await WIKI.models.assetServing.resolveAssetPath(site.id, req.params['*'] ?? '')
    // -> Not readable is answered as not there, so the URL cannot be used to probe for files
    //
    // -> Resolved by hostname, not a `:siteId` path param, so `apiKeySitePinHook`
    //    (`helpers/apiKeySite.ts`) never sees this route -- but a site-pinned API key is refused
    //    here anyway, one layer down: `actorForRequest()` carries the pin onto `checkAccess()`'s
    //    actor, which refuses a `siteId` other than the pin before any rule is even consulted
    //    (OpenProject #2189/#2199/#2201). No separate `enforceApiKeySite()` call needed.
    if (!asset || !mayOnAsset(req, 'read:assets', site.id, asset)) {
      return reply.notFound('File not found')
    }

    /*
      The ID and the timestamp together, because either one alone lies: a file replaced at the same
      path is a different asset under the same URL, and one edited in place keeps its ID.
    */
    // -> `notModifiedOrPrepare` also sends `X-Content-Type-Options: nosniff`: the bytes came from a
    //    user, so the browser must take the type at its word rather than looking for something more
    //    interesting in them
    const etag = `"${asset.id}-${asset.updatedAt.getTime()}"`
    if (notModifiedOrPrepare(req, reply, { etag, cacheControl: FILE_CACHE })) {
      return reply
    }

    const content = await WIKI.models.assetServing.readContent(asset, site.id)
    if (!content) {
      // -> The path resolved to a row that is no longer there, so the resolution was a stale one
      WIKI.models.assetServing.forgetPath(site.id, asset.folderPath, asset.fileName)
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
    // -> Neutralizes an SVG or HTML/XHTML file opened as a document rather than embedded — see
    //    `helpers/security.ts`'s `SVG_CSP` for the full reasoning; the same header
    //    `controllers/site.ts` attaches to an admin-uploaded logo/favicon SVG
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
