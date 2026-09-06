import { enforceApiKeySite } from '../helpers/apiKeySite.ts'
import { replyWithFile } from '../helpers/common.ts'
import { guardSiteEnabled, resolveSiteParam } from '../helpers/siteResolution.ts'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import { svgMimeType } from '../helpers/images.ts'
import { SVG_CSP } from '../helpers/security.ts'
import path from 'node:path'
import type { SiteAssetKind } from '../models/sites.ts'
import type { FastifyInstance } from 'fastify'

/**
 * What is served for each of a site's images while nobody has uploaded one. The keys are the names
 * the images are addressed by, which are the asset kinds themselves; the values are paths relative
 * to `WIKI.SERVERPATH`, i.e. inside `backend/` itself.
 *
 * These used to point into `assets/_assets/`, which is `frontend/`'s `vite build` output and is
 * gitignored — so the backend's own branding depended on a build of another workspace having run,
 * and reached it only as a side effect of `frontend/public/` being copied verbatim into `assets/`.
 * An unbuilt or merely stale `assets/` therefore left `node backend` serving the wrong mark, or
 * nothing at all, with no signal distinguishing that from "no logo configured" (OpenProject #2611).
 * `backend/assets/branding/` is committed source instead, and is inside the one tree
 * `dev/build/Dockerfile` already copies wholesale, so the file is there whether or not anything has
 * been built.
 *
 * `frontend/public/_assets/logo-cardinal.svg` is a deliberate second copy, not this one: the Vite
 * dev server and the built bundle answer `/_assets/logo-cardinal.svg` for `AdminLayout.vue` and
 * `WelcomeOverlay.vue` out of `public/`, which is a different path space from this table and stays
 * that way. `controllers/site.test.ts` asserts the two copies are byte-identical so they cannot
 * drift apart. The login background has no such second reader — nothing outside this table ever
 * served it — so it lives here alone.
 *
 * Exported so `controllers/site.test.ts` can assert every path in it actually resolves on disk,
 * rather than re-listing them and going stale the moment a fourth asset kind is added.
 */
export const SITE_ASSET_FALLBACKS: Record<SiteAssetKind, string> = {
  logo: 'assets/branding/logo-cardinal.svg',
  favicon: 'assets/branding/logo-cardinal.svg',
  loginBg: 'assets/branding/login-bg.jpg'
}

/**
 * An uploaded site image changes whenever an administrator replaces it, and the URL never carries a
 * version — so it is always revalidated, and the ETag turns that into an empty 304 rather than a
 * re-download.
 *
 * Only the uploaded branch below sends this constant (plus its own strong sha1 ETag) — the
 * `replyWithFile` fallback further down sends its own, longer-lived `Cache-Control` instead (see
 * `helpers/common.ts`). That split is intentional, not an oversight: the fallback's bytes are a
 * fixed path under this backend's own `assets/branding/`, which only ever changes via a redeploy (a
 * new deployment, a new process), not a request an administrator can make against a running instance
 * the way an upload is — so it can be cached long instead of always-revalidated, while
 * `replyWithFile` still gives it a validator for the rare revalidation (a forced reload, or the
 * cache window elapsing).
 */
const SITE_ASSET_CACHE = 'public, no-cache'

/**
 * Every current consumer of a site image — `HeaderNav.vue`, `Login.vue`, `AdminGeneral.vue` — loads
 * it inside an `<img>`, and a browser never executes script markup found through `<img src>`
 * regardless of any response header; that holds for an SVG exactly as it would for any other image
 * format. So this header is not what stops a malicious upload from running in the app's own UI —
 * nothing needs to, because `<img>` already can't run it. What it actually guards against is the
 * request nothing here otherwise controls: this same URL fetched *outside* an `<img>` context —
 * typed directly into the address bar, or loaded through `<object>`/`<iframe>`/a same-origin
 * top-level navigation — where a browser would otherwise treat the response as an HTML-capable
 * document and run whatever the file contains, in this origin, as whoever is looking at it. Uploading
 * one takes `manage:sites`, which already allows injecting markup into every page of the site — but
 * that is a reason to keep the blast radius of a stolen admin session small, not to ignore it.
 * Nothing legitimate in a logo needs more than the markup itself, so the response allows nothing
 * else. (Verified manually against an uploaded SVG carrying a `<script>` payload in both Chrome and
 * Firefox: rendered via `<img src>` it never runs, matching the reasoning above regardless of this
 * header; opened directly in a new tab, this header's `sandbox` neutralizes it in both browsers.)
 *
 * `SVG_CSP` itself now lives in `helpers/security.ts`, shared with `controllers/files.ts` and
 * `api/assets.ts`'s `/content` route so all three cannot drift apart (OpenProject #2157).
 */

/**
 * _site Routes
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string; resource: string } }>(
    '/:siteId/:resource',
    async (req, reply) => {
      const site = await resolveSiteParam(req.params.siteId, req.hostname)
      if (!site) {
        return reply.notFound('Site not found')
      }
      // -> This route resolves its own site independently of the `:siteId` path param the global
      //    `apiKeySitePinHook` (`helpers/apiKeySite.ts`, registered in `index.ts`) reads -- the
      //    literal param value here can be the sentinel `'current'` or a hostname, not necessarily
      //    the real site id, so that hook deliberately leaves this prefix alone (OpenProject #2201).
      //    Called with the resolved `site.id`, not `req.params.siteId`, for exactly that reason.
      if (!enforceApiKeySite(req, reply, site.id)) {
        return
      }
      // -> A disabled site's logo/favicon/login background is still identifying content: this is a
      //    logged-out request, so nothing downstream of here decides who may see it, only the hook
      //    that resolved the page around the `<img>` tag -- which is exactly the check this route
      //    never runs through, since it resolves its own siteId independently
      if (guardSiteEnabled(site, reply)) {
        return reply
      }

      const kind = req.params.resource as SiteAssetKind
      const fallback = SITE_ASSET_FALLBACKS[kind]
      if (!fallback) {
        return reply.badRequest('Invalid Site Resource')
      }

      // -> The flag lives in the cached site config, so a site that has uploaded nothing — which is
      //    every site until an administrator says otherwise — never touches the database here
      const hash = site.config.assets?.[kind]
        ? await WIKI.models.sites.getAssetHash(site.id, kind)
        : null
      if (!hash) {
        // -> No SVG_CSP here: this file's bytes are picked by the codebase (`SITE_ASSET_FALLBACKS`),
        //    never by anything a request can influence, so the admin-upload risk that header guards
        //    against doesn't apply to it. Cache-Control/ETag/Last-Modified DO apply — `replyWithFile`
        //    sends all three — since this is still a same-origin file every hard load would otherwise
        //    re-download in full.
        // -> `SERVERPATH`, not `ROOTPATH`: the fallbacks are backend-owned committed files, so they
        //    are resolved inside `backend/` rather than against a build output directory that may not
        //    exist yet (OpenProject #2611).
        return replyWithFile(req, reply, path.join(WIKI.SERVERPATH, fallback))
      }

      // -> Answered from the hash column alone whenever possible: a conditional request never has to
      //    read the blob back out of the database or hash it. The blob is only read below, to build
      //    the 200 response, when the ETag does not match.
      // -> `notModifiedOrPrepare` also sends `X-Content-Type-Options: nosniff`: the bytes were
      //    uploaded, so the browser must take the type at its word rather than looking for something
      //    more interesting in them
      if (notModifiedOrPrepare(req, reply, { etag: `"${hash}"`, cacheControl: SITE_ASSET_CACHE })) {
        return reply
      }

      // -> Theoretical only (`hash` and `data` are written together by `setAsset` and removed
      //    together by `clearAsset`): a hash existing but the row being gone by the time this second
      //    read runs would mean it was deleted in between, which the headers already sent above
      //    (built from the now-stale hash) cannot un-send — so this reports the asset as gone rather
      //    than silently serving the unrelated static fallback under those headers.
      const asset = await WIKI.models.sites.getAsset(site.id, kind)
      if (!asset) {
        return reply.notFound('Site Resource not found')
      }
      if (asset.mime === svgMimeType) {
        reply.header('Content-Security-Policy', SVG_CSP)
      }

      return reply.type(asset.mime).send(asset.data)
    }
  )
}

export default routes
