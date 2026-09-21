import crypto from 'node:crypto'
import { enforceApiKeySite } from '../helpers/apiKeySite.ts'
import { replyWithFile } from '../helpers/common.ts'
import { guardSiteEnabled, resolveSiteParam } from '../helpers/siteResolution.ts'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import { svgMimeType } from '../helpers/images.ts'
import { SVG_CSP } from '../helpers/security.ts'
import path from 'node:path'
import { DEFAULT_THEME_COLORS, type SiteAssetKind } from '../models/sites.ts'
import type { FastifyInstance } from 'fastify'

type SiteIconKind = 'icon-192' | 'icon-512'

/**
 * What is served for each of a site's images while nobody has uploaded one. Paths are relative to
 * `CARDINAL.SERVERPATH`: committed files inside `backend/`, not `frontend/`'s gitignored build output,
 * so they are there whether or not anything has been built.
 *
 * `frontend/public/_assets/logo-cardinal.svg` is a deliberate second copy, served out of `public/` for
 * the frontend's own use; `controllers/site.test.ts` asserts the two are byte-identical.
 */
export const SITE_ASSET_FALLBACKS: Record<SiteAssetKind | SiteIconKind, string> = {
  logo: 'assets/branding/logo-cardinal.svg',
  favicon: 'assets/branding/favicon.ico',
  loginBg: 'assets/branding/login-bg.jpg',
  'icon-192': 'assets/branding/icon-192.png',
  'icon-512': 'assets/branding/icon-512.png'
}

/**
 * For an upload and the built-in fallback alike: an administrator can replace the one and a redeploy
 * the other, and the URL never carries a version, so it is always revalidated — the ETag turns that
 * into an empty 304 rather than a re-download.
 */
const SITE_ASSET_CACHE = 'public, no-cache'

function themeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

export function buildSiteManifest(
  site: { id: string; config?: Record<string, any> },
  logo: { mime: string } | null
): Record<string, unknown> {
  const config = site.config ?? {}
  const title =
    typeof config.title === 'string' && config.title.trim() !== '' ? config.title : 'Cardinal.js'
  const base = `/_site/${site.id}`
  const icons = !logo
    ? [
        { src: `${base}/icon-192`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `${base}/icon-512`, sizes: '512x512', type: 'image/png', purpose: 'any' }
      ]
    : logo.mime === svgMimeType
      ? [{ src: `${base}/logo`, sizes: 'any', type: logo.mime, purpose: 'any' }]
      : [
          { src: `${base}/logo`, sizes: '192x192', type: logo.mime, purpose: 'any' },
          { src: `${base}/logo`, sizes: '512x512', type: logo.mime, purpose: 'any' }
        ]
  const manifest: Record<string, unknown> = {
    name: title,
    short_name: title.length > 12 ? title.slice(0, 12).trimEnd() : title,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: themeColor(config.theme?.colorPrimary, DEFAULT_THEME_COLORS.colorPrimary),
    background_color: themeColor(config.theme?.colorHeader, DEFAULT_THEME_COLORS.colorHeader),
    icons
  }
  if (typeof config.description === 'string' && config.description !== '') {
    manifest.description = config.description
  }
  return manifest
}

async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string; resource: string } }>(
    '/:siteId/:resource',
    async (req, reply) => {
      const site = await resolveSiteParam(req.params.siteId, req.hostname)
      if (!site) {
        return reply.notFound('Site not found')
      }
      // -> `:siteId` here can be the sentinel `'current'` or a hostname, so the global
      //    `apiKeySitePinHook` leaves this prefix alone -- checked here, against the resolved `site.id`
      if (!enforceApiKeySite(req, reply, site.id)) {
        return
      }
      // -> A disabled site's logo/favicon/login background is still identifying content, and the
      //    page/shell hook's disabled-site check does not cover this route
      if (guardSiteEnabled(site, reply)) {
        return reply
      }

      if (req.params.resource === 'manifest') {
        const logo = site.config.assets?.logo
          ? await CARDINAL.models.sites.getAsset(site.id, 'logo')
          : null
        const body = JSON.stringify(buildSiteManifest(site, logo))
        const etag = `"${crypto.createHash('sha1').update(body).digest('hex')}"`
        reply.type('application/manifest+json')
        if (notModifiedOrPrepare(req, reply, { etag, cacheControl: SITE_ASSET_CACHE })) {
          return reply
        }
        return reply.send(body)
      }

      const kind = req.params.resource as SiteAssetKind
      const fallback = SITE_ASSET_FALLBACKS[kind]
      if (!fallback) {
        return reply.badRequest('Invalid Site Resource')
      }

      // -> The flag lives in the cached site config, so a site that has uploaded nothing never touches
      //    the database here
      const hash = site.config.assets?.[kind]
        ? await CARDINAL.models.sites.getAssetHash(site.id, kind)
        : null
      if (!hash) {
        // -> No `SVG_CSP` here: this file's bytes are picked by the codebase, never by anything a
        //    request can influence
        return replyWithFile(req, reply, path.join(CARDINAL.SERVERPATH, fallback), {
          cacheControl: SITE_ASSET_CACHE
        })
      }

      // -> Answered from the hash column alone: a conditional request never has to read the blob back
      //    out of the database or hash it
      // -> `notModifiedOrPrepare` also sends `nosniff`: the bytes were uploaded
      if (notModifiedOrPrepare(req, reply, { etag: `"${hash}"`, cacheControl: SITE_ASSET_CACHE })) {
        return reply
      }

      // -> Theoretical only (`setAsset`/`clearAsset` write and remove `hash` and `data` together): a
      //    row deleted between the two reads. The headers above were built from the now-stale hash,
      //    so this reports the asset as gone rather than serving the static fallback under them.
      const asset = await CARDINAL.models.sites.getAsset(site.id, kind)
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
