import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { resolveAppShellLocale, getTemplatedAppShell } from '../../helpers/appShell.ts'
import {
  localePrefixRedirectTarget,
  localePrefixStripTarget,
  resolveRequestSite,
  siteIdForHostname,
  stripPageExtension
} from '../../helpers/common.ts'

/**
 * Everything that decides WHICH site (and which canonical URL) a page-shaped request belongs to: the
 * SEO canonicalisation redirects, the per-request site resolution, and the app-shell fallback the
 * SPA is served from.
 */

/**
 * Files a browser or a crawler asks for at the root by convention, rather than because the wiki has a
 * page there. Kept out of the page URL rules below — `txt` is a page extension on a default site, and
 * answering `/robots.txt` with a redirect to `/robots` would be answering the wrong question.
 *
 * `metrics` rides along for the same reason despite not being a "file": `controllers/metrics.ts`
 * registers an unprefixed `/metrics` for Prometheus's fixed scrape convention, which without this
 * entry `isPageUrl()` below reads as a page navigation — a scrape against a hostname mapping to no
 * site (or a disabled one) would 302 to `/_error/unknownsite` / `/_error/disabled` before ever
 * reaching the registered route, and Prometheus follows redirects by default, so it would fail
 * parsing the SPA shell instead of getting a scrape failure that says why (OpenProject #938).
 */
export const RESERVED_ROOT_FILES = new Set(['favicon.ico', 'robots.txt', 'sitemap.xml', 'metrics'])

/**
 * First path segments the SERVER itself answers — every prefix registered in `core/http/routes.ts`.
 *
 * Spelled out rather than tested with `isPageUrl`, because a leading underscore does not mean the
 * server: the frontend router owns `/_admin`, `/_profile`, `/_inbox`, `/_search`, `/_create`, `/_edit`
 * and `/_error` too, and those have to reach the app shell like any page path. The distinction the
 * shell needs is "does something here serve this", which is this list, and it has to be kept in step
 * with the registrations there.
 */
export const SERVER_ROUTE_SEGMENTS = new Set([
  '_api',
  '_assets',
  '_blocks',
  '_collab',
  '_files',
  '_icons',
  '_mcp',
  '_render',
  '_site',
  '_terminal',
  '_thumb',
  '_user'
])

/**
 * Whether a URL addresses the page tree rather than the server itself.
 *
 * Everything the server mounts sits under a leading-underscore segment — `/_api`, `/_assets`,
 * `/_files`, and the rest registered in `core/http/routes.ts` — which is what makes the distinction a
 * prefix test rather than a list to keep in step with the routes.
 */
export function isPageUrl(urlPath: string): boolean {
  const firstSegment = urlPath.split('/')[1] ?? ''
  return !firstSegment.startsWith('_') && !RESERVED_ROOT_FILES.has(firstSegment.toLowerCase())
}

/**
 * `isPageUrl` first segments that must reach the app shell even when the hostname resolves to no
 * site, or to one with `isEnabled === false` — the fix path for either state has to survive the very
 * thing it exists to correct, or a disabled site locks its own administrator out of re-enabling it.
 *
 * `login` is the only entry: everything else an operator needs — `/_admin` itself, and the
 * `/_api/sites/*` route `manage:sites` calls to flip `isEnabled` back on — already sits under a
 * leading-underscore segment, which `isPageUrl` excludes before this list is ever consulted. `/login`
 * is the one page-shaped exception, since (unlike `/_admin`) it is owned by the SPA router rather than
 * mounted here, and it is the only way to obtain the session `/_admin` requires in the first place.
 */
const SITE_RESOLUTION_EXEMPT_SEGMENTS = new Set(['login'])

/**
 * Trims the one trailing slash a page URL may carry, leaving a bare `/` alone. The SEO hook redirects
 * to the trimmed form; the site-resolution hook reads it to decide which site the request is for.
 */
function trimTrailingSlash(urlPath: string): string {
  return urlPath.length > 1 && urlPath.endsWith('/') ? urlPath.slice(0, -1) : urlPath
}

/**
 * Canonicalisation redirects for page URLs: page extension, locale prefix, trailing slash.
 */
export function registerSeoRedirects(app: FastifyInstance): void {
  app.addHook('onRequest', (req, reply, done) => {
    const [urlPath, urlQuery] = req.raw.url!.split('?')
    const withQuery = (newPath: string) => (urlQuery ? `${newPath}?${urlQuery}` : newPath)

    const trimmed = trimTrailingSlash(urlPath!)

    if (isPageUrl(trimmed)) {
      // -> Straight off the site caches rather than through the model: this runs on every request, and
      //    both lookups are the ones `getSiteByHostname` would do, minus its optional reload
      const siteId = siteIdForHostname(req.hostname)
      const siteConfig = siteId ? WIKI.sites[siteId]?.config : undefined
      const withoutExtension = stripPageExtension(trimmed, siteConfig?.pageExtensions)
      if (withoutExtension) {
        // -> Answers a trailing slash as well, rather than sending the client back for a second
        //    round trip to be told about the extension.
        //
        //    Not a 301: which extensions resolve this way is a setting, and a browser that cached a
        //    permanent redirect would go on applying it after an administrator had changed it
        reply.redirect(withQuery(withoutExtension), 302)
        return
      }

      // -> `SERVER_ROUTE_SEGMENTS` and `RESERVED_ROOT_FILES` are already excluded by `isPageUrl`
      //    above, so a locale code can never collide with one of those first segments here.
      const localeRedirect = localePrefixRedirectTarget(trimmed, siteConfig?.locales)
      if (localeRedirect) {
        // -> Same reasoning as the extension redirect above: `forcePrefix` is a setting, not a
        //    permanent fact about the URL, so a 301 here would outlive an admin turning it off.
        reply.redirect(withQuery(localeRedirect), 302)
        return
      }

      // -> The mirror image: an explicit prefix the site's rules leave bare (`/en/page`) 302s to
      //    the one canonical URL (`/page`), and a mis-cased prefix re-cases. 302 for the same
      //    reason as above — which locales are active, and forcePrefix, are settings.
      const localeStrip = localePrefixStripTarget(trimmed, siteConfig?.locales)
      if (localeStrip) {
        reply.redirect(withQuery(localeStrip), 302)
        return
      }
    }

    if (trimmed !== urlPath) {
      reply.redirect(withQuery(trimmed), 301)
      return
    }

    done()
  })
}

/**
 * Resolves the site a page-shaped request belongs to onto `req.site`, bouncing a hostname that
 * addresses no site (or a disabled one) to the matching `/_error/*` page.
 */
export function registerSiteResolution(app: FastifyInstance): void {
  app.decorateRequest('site', null)

  app.addHook('onRequest', (req, reply, done) => {
    const urlPath = req.raw.url!.split('?')[0]!
    const trimmed = trimTrailingSlash(urlPath)

    // -> Not in scope for the server's own routes, static assets, etc. — see `isPageUrl`
    if (!isPageUrl(trimmed)) {
      return done()
    }

    const firstSegment = trimmed.split('/')[1] ?? ''
    const resolution = resolveRequestSite({
      firstSegment,
      hostname: req.hostname,
      sitesMappings: WIKI.sitesMappings,
      sites: WIKI.sites,
      exemptSegments: SITE_RESOLUTION_EXEMPT_SEGMENTS
    })

    switch (resolution.outcome) {
      case 'exempt':
        return done()
      case 'ok':
        req.site = resolution.site
        return done()
      case 'disabled':
        // -> Distinguishable from "not-found" below: this hostname does address a real site, it is
        //    just switched off, which is a different message (and a different fix) for whoever hits it
        req.site = resolution.site
        // -> A 302, not a 301: `isEnabled` is a setting an administrator can flip back, and a browser
        //    that cached a permanent redirect would keep bouncing here after they did
        reply.redirect('/_error/disabled', 302)
        return
      case 'not-found':
        reply.redirect('/_error/unknownsite', 302)
        return
    }
  })
}

/**
 * The compiled SPA, for every path no route claimed.
 *
 * It has to be the fallback rather than a route of its own: a wiki page lives at any path a user cares
 * to give it, and the frontend's router -- not this server -- is what resolves one. Which is also why
 * the only paths held back are the segments the server itself mounts, so a mistyped `/_api/...` still
 * answers as the API rather than handing back a page of HTML, and the root files a crawler asks for by
 * convention, which are absent here rather than being the app.
 *
 * `no-store`: the bundles this pulls in are hashed and immutable under `/_assets`, but the document
 * naming them must never be held, or a rebuilt frontend would keep booting the previous one. Stat'd
 * per request for the same reason -- `npm run build` while the server is up should be enough. It
 * also means a cache never has to be told the templated `lang`/`dir` below vary per site, since
 * nothing is cached at all client-side (the server-side memo below is a from-scratch re-template
 * keyed on that same stat, not a cache the client could ever observe).
 *
 * `lang`/`dir` are filled in here rather than left to `App.vue` (which also sets them, from
 * `siteStore.locales`, the moment it boots): that only happens once its JS has loaded, parsed and
 * run, so an RTL locale would flash LTR for however long that takes. Templating them into the shell
 * itself closes that window -- see `helpers/appShell.ts`, whose `getTemplatedAppShell` memoises the
 * templated output per `(lang, isRTL)` pair (there are only a handful) rather than re-reading and
 * re-templating the shell on every request; it also keeps `getLocales()` off the hot path for an
 * already-seen `lang`, only calling it again once the shell file's `mtimeMs` moves.
 */
export function registerAppShellFallback(app: FastifyInstance): void {
  const appShellPath = path.join(WIKI.ROOTPATH, 'assets/index.html')

  app.setNotFoundHandler(async (req, reply) => {
    const [urlPath, urlSearch] = req.raw.url!.split('?')
    const firstSegment = urlPath!.split('/')[1] ?? ''
    const isSystemPath = SERVER_ROUTE_SEGMENTS.has(firstSegment)
    const isReservedRootFile = RESERVED_ROOT_FILES.has(firstSegment.toLowerCase())
    // -> HEAD as well as GET: it has to answer what GET would, or a monitor pointed at the wiki reads a
    //    404 for a page the browser beside it loads. Node drops the body for HEAD on its own.
    const isReadRequest = req.method === 'GET' || req.method === 'HEAD'
    if (!isReadRequest || isSystemPath || isReservedRootFile) {
      return reply.notFound()
    }
    try {
      // -> Same site resolution as the SEO hook above: straight off the caches, since this also
      //    runs on every request that reaches the shell.
      const siteId = siteIdForHostname(req.hostname)
      const siteConfig = siteId ? WIKI.sites[siteId]?.config : undefined
      const lang = resolveAppShellLocale(urlPath!, urlSearch, siteConfig?.locales)
      const templated = await getTemplatedAppShell(appShellPath, lang, async () => {
        const locales = await WIKI.models.locales.getLocales()
        return locales.find((l: any) => l.code === lang)?.isRTL ?? false
      })
      return reply
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(templated)
    } catch (err: any) {
      // -> Nothing to serve means the frontend was never built, which is a setup step rather than a
      //    fault of this request: say which one, since a bare 500 sends people looking in the server
      WIKI.logger.error(`Cannot serve the app shell from ${appShellPath}: ${err.message}`)
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('The frontend has not been built yet. Run `npm run build` in frontend/.\n')
    }
  })
}
