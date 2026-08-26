import { guardSiteEnabled, isValidUuid, replyWithFile } from '../helpers/common.ts'
import { svgMimeType } from '../helpers/images.ts'
import { SVG_CSP } from '../helpers/security.ts'
import crypto from 'node:crypto'
import path from 'node:path'
import type { SiteAssetKind } from '../models/sites.ts'
import type { FastifyInstance } from 'fastify'

/**
 * What is served for each of a site's images while nobody has uploaded one. The keys are the names
 * the images are addressed by, which are the asset kinds themselves.
 */
const SITE_ASSET_FALLBACKS: Record<SiteAssetKind, string> = {
  logo: 'assets/_assets/logo-wikijs.svg',
  favicon: 'assets/_assets/logo-wikijs.svg',
  loginBg: 'assets/_assets/bg/login.jpg'
}

/**
 * An uploaded site image changes whenever an administrator replaces it, and the URL never carries a
 * version — so it is always revalidated, and the ETag turns that into an empty 304 rather than a
 * re-download.
 *
 * Only the uploaded branch below sends this (plus the ETag): the `replyWithFile` fallback further
 * down sends neither. That is intentional, not a gap this file forgot to close — the fallback's
 * bytes are a fixed path under this repo's own `assets/_assets/`, which only ever changes via a
 * redeploy (a new build, a new process), not a request an administrator can make against a running
 * instance the way an upload is. There is no per-instance revalidation problem to solve for content
 * that cannot change out from under a live process.
 */
const SITE_ASSET_CACHE = 'public, no-cache'

/**
 * Every current consumer of a site image — `HeaderNav.vue`, `Login.vue`, `AdminGeneral.vue` — loads
 * it inside an `<img>`, and a browser never executes script markup found through `<img src>`
 * regardless of any response header; that holds for an SVG exactly as it would for any other image
 * format. So `SVG_CSP` (`helpers/security.ts`) is not what stops a malicious upload from running in
 * the app's own UI — nothing needs to, because `<img>` already can't run it. Uploading one takes
 * `manage:sites`, which already allows injecting markup into every page of the site — but that is a
 * reason to keep the blast radius of a stolen admin session small, not to ignore it. See
 * `helpers/security.ts` for what the header actually guards against and how it was verified.
 */

/**
 * _site Routes
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string; resource: string } }>(
    '/:siteId/:resource',
    async (req, reply) => {
      let site: any
      if (req.params.siteId === 'current' && req.hostname) {
        site = await WIKI.models.sites.getSiteByHostname({ hostname: req.hostname })
      } else if (isValidUuid(req.params.siteId)) {
        site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      } else {
        site = await WIKI.models.sites.getSiteByHostname({ hostname: req.params.siteId })
      }
      if (!site) {
        return reply.notFound('Site not found')
      }
      // -> A disabled site's logo/favicon/login background is still identifying content: this is a
      //    logged-out request, so nothing downstream of here decides who may see it, only the hook
      //    that resolved the page around the `<img>` tag -- which is exactly the check this route
      //    never runs through, since it resolves its own siteId independently
      if (guardSiteEnabled(site, reply)) {
        return
      }

      const kind = req.params.resource as SiteAssetKind
      const fallback = SITE_ASSET_FALLBACKS[kind]
      if (!fallback) {
        return reply.badRequest('Invalid Site Resource')
      }

      // -> The flag lives in the cached site config, so a site that has uploaded nothing — which is
      //    every site until an administrator says otherwise — never touches the database here
      const asset = site.config.assets?.[kind]
        ? await WIKI.models.sites.getAsset(site.id, kind)
        : null
      if (!asset) {
        // -> No SVG_CSP/ETag/Cache-Control here either, and for the same reason for each: this file's
        //    bytes are picked by the codebase (`SITE_ASSET_FALLBACKS`), never by anything a request
        //    can influence, so none of the risks those headers guard against — an admin-uploaded
        //    payload, content changing under an unversioned URL — apply to it.
        return replyWithFile(reply, path.join(WIKI.ROOTPATH, fallback))
      }

      const etag = `"${crypto.createHash('sha1').update(asset.data).digest('hex')}"`
      reply.header('ETag', etag)
      reply.header('Cache-Control', SITE_ASSET_CACHE)
      // -> The bytes were uploaded, so the browser must take the type at its word rather than looking
      //    for something more interesting in them
      reply.header('X-Content-Type-Options', 'nosniff')
      if (asset.mime === svgMimeType) {
        reply.header('Content-Security-Policy', SVG_CSP)
      }
      if (req.headers['if-none-match'] === etag) {
        return reply.code(304).send()
      }

      return reply.type(asset.mime).send(asset.data)
    }
  )
}

export default routes
