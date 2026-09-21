import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import {
  resolveAppShellLocale,
  getTemplatedAppShell,
  insertIntoAppShell,
  mergeShellFragments
} from '../../helpers/appShell.ts'
import { requestOrigin, stripPageExtension } from '../../helpers/common.ts'
import { analyticsShellFragments } from '../../helpers/analyticsSnippets.ts'
import { pageShellFragments, withShellTitle } from '../../helpers/shellHead.ts'
import { lookupShellPage, type ShellPage } from '../../helpers/shellPage.ts'
import { robotsDirective, robotsShellFragments } from '../../helpers/shellRobots.ts'
import { themeShellFragments } from '../../helpers/shellTheme.ts'
import { localePrefixRedirectTarget, localePrefixStripTarget } from '../../helpers/localeRouting.ts'
import {
  applyEmbedFrameAncestors,
  resolveRequestSite,
  siteIdForHostname
} from '../../helpers/siteResolution.ts'

/**
 * Files a browser or a crawler asks for at the root by convention, rather than because the wiki has a
 * page there. Kept out of the page URL rules below — `txt` is a page extension on a default site, and
 * answering `/robots.txt` with a redirect to `/robots` would be answering the wrong question.
 *
 * `metrics` is here because `controllers/metrics.ts` registers an unprefixed `/metrics` for
 * Prometheus's fixed scrape convention. Read as a page path, a scrape against an unmapped or
 * disabled hostname would 302 to an `/_error/*` page before reaching the route, and Prometheus
 * follows redirects, so it would fail parsing the SPA shell rather than report why.
 */
export const RESERVED_ROOT_FILES = new Set(['favicon.ico', 'robots.txt', 'sitemap.xml', 'metrics'])

/**
 * First path segments the SERVER itself answers. Keep in step with the underscore prefixes mounted
 * in `core/http/routes.ts` and `./server.ts#registerStaticAssets`.
 *
 * Spelled out rather than tested with `isPageUrl`, because a leading underscore does not mean the
 * server: the frontend router owns `/_admin`, `/_error` and others, and those have to reach the app
 * shell like any page path.
 */
export const SERVER_ROUTE_SEGMENTS = new Set([
  '_api',
  '_assets',
  '_blocks',
  '_collab',
  '_files',
  '_icons',
  '_mcp',
  '_pages',
  '_render',
  '_site',
  '_terminal',
  '_thumb',
  '_user'
])

/**
 * Whether a URL addresses the page tree rather than the server itself. `RESERVED_ROOT_FILES` aside,
 * everything the server mounts sits under a leading-underscore segment, which makes this a prefix
 * test rather than a list to keep in step with the routes.
 */
export function isPageUrl(urlPath: string): boolean {
  const firstSegment = urlPath.split('/')[1] ?? ''
  return !firstSegment.startsWith('_') && !RESERVED_ROOT_FILES.has(firstSegment.toLowerCase())
}

/**
 * `isPageUrl` first segments that must reach the app shell even when the hostname resolves to no
 * site, or to a disabled one — otherwise a disabled site locks its own administrator out of
 * re-enabling it.
 *
 * `login` is the only entry: `/_admin` and the `/_api/sites/*` route that flips `isEnabled` back on
 * are underscore paths `isPageUrl` already excludes. `/login` is page-shaped, and the only way to
 * obtain the session `/_admin` requires.
 */
const SITE_RESOLUTION_EXEMPT_SEGMENTS = new Set(['login'])

const SPA_APP_ROUTES: readonly RegExp[] = [
  /^\/login(\/reset-password\/[^/]+)?$/,
  /^\/a\/[^/]+$/,
  /^\/i\/[^/]+$/,
  /^\/_(search|tags|graph)$/,
  /^\/_version\/[^/]+$/,
  /^\/_admin(\/.*)?$/,
  /^\/_error(\/[^/]+)?$/,
  /^\/_create(\/[^/]+)?$/,
  /^\/_edit(\/.*)?$/
]

export function isSpaAppRoute(urlPath: string): boolean {
  const trimmed = trimTrailingSlash(urlPath)
  return SPA_APP_ROUTES.some((route) => route.test(trimmed))
}

function trimTrailingSlash(urlPath: string): string {
  return urlPath.length > 1 && urlPath.endsWith('/') ? urlPath.slice(0, -1) : urlPath
}

export function registerSeoRedirects(app: FastifyInstance): void {
  app.addHook('onRequest', (req, reply, done) => {
    const [urlPath, urlQuery] = req.raw.url!.split('?')
    const withQuery = (newPath: string) => (urlQuery ? `${newPath}?${urlQuery}` : newPath)

    const trimmed = trimTrailingSlash(urlPath!)

    if (isPageUrl(trimmed)) {
      // -> Straight off the site caches rather than through the model: this runs on every request.
      const siteId = siteIdForHostname(req.hostname)
      const siteConfig = siteId ? CARDINAL.sites[siteId]?.config : undefined
      const withoutExtension = stripPageExtension(trimmed, siteConfig?.pageExtensions)
      if (withoutExtension) {
        // -> Answers a trailing slash as well, sparing the client a second round trip.
        //    Not a 301: which extensions resolve this way is a setting, and a browser that cached a
        //    permanent redirect would go on applying it after an administrator had changed it
        reply.redirect(withQuery(withoutExtension), 302)
        return
      }

      const localeRedirect = localePrefixRedirectTarget(trimmed, siteConfig?.locales)
      if (localeRedirect) {
        // -> 302 for the same reason as above: `forcePrefix` is a setting.
        reply.redirect(withQuery(localeRedirect), 302)
        return
      }

      // -> The mirror image: an explicit prefix the site's rules leave bare (`/en/page`) 302s to
      //    the one canonical URL (`/page`), and a mis-cased prefix re-cases.
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

export function registerSiteResolution(app: FastifyInstance): void {
  app.decorateRequest('site', null)

  app.addHook('onRequest', (req, reply, done) => {
    const urlPath = req.raw.url!.split('?')[0]!
    const trimmed = trimTrailingSlash(urlPath)

    if (!isPageUrl(trimmed)) {
      return done()
    }

    const firstSegment = trimmed.split('/')[1] ?? ''
    const resolution = resolveRequestSite({
      firstSegment,
      hostname: req.hostname,
      sitesMappings: CARDINAL.sitesMappings,
      sites: CARDINAL.sites,
      exemptSegments: SITE_RESOLUTION_EXEMPT_SEGMENTS
    })

    switch (resolution.outcome) {
      case 'exempt':
        return done()
      case 'ok':
        req.site = resolution.site
        applyEmbedFrameAncestors(resolution.site, reply)
        return done()
      case 'disabled':
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
 * The compiled SPA, for every path no route claimed. A fallback rather than a route of its own: a
 * wiki page lives at any path, and the frontend's router -- not this server -- resolves one. The
 * segments the server mounts and the reserved root files are held back, so a mistyped `/_api/...`
 * still answers as the API rather than handing back a page of HTML.
 *
 * `no-store`: the bundles this pulls in are hashed and immutable under `/_assets`, but the document
 * naming them must never be held, or a rebuilt frontend would keep booting the previous one. Stat'd
 * per request for the same reason -- `npm run build` while the server is up should be enough.
 *
 * `lang`/`dir` are templated here rather than left to `App.vue`, which sets them only once its JS
 * has run, so an RTL locale would flash LTR until then. `helpers/appShell.ts#getTemplatedAppShell`
 * memoises the result, keeping the file read and `getLocales()` off the hot path.
 */
export function registerAppShellFallback(app: FastifyInstance): void {
  const appShellPath = path.join(CARDINAL.ROOTPATH, 'assets/index.html')

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
      const siteId = siteIdForHostname(req.hostname)
      const siteConfig = siteId ? CARDINAL.sites[siteId]?.config : undefined
      const lang = resolveAppShellLocale(urlPath!, urlSearch, siteConfig?.locales)
      const template = await getTemplatedAppShell(appShellPath, lang, async () => {
        const locales = await CARDINAL.models.locales.getLocales()
        return locales.find((l: any) => l.code === lang)?.isRTL ?? false
      })
      let shellPage: ShellPage | null = null
      let status = 200
      if (!isSpaAppRoute(urlPath!)) {
        status = 404
        if (siteId && isPageUrl(urlPath!)) {
          try {
            shellPage = await lookupShellPage({ siteId, urlPath: urlPath!, locale: lang })
            status = shellPage ? 200 : 404
          } catch (err: any) {
            // -> Fail open: a DB error says nothing about whether the page exists, and a 404 would
            //    tell crawlers to drop it.
            status = 200
            CARDINAL.logger.warn('http', 'cannot look up the page for the app shell', {
              error: err
            })
          }
        }
      }
      const pageFragments = shellPage
        ? pageShellFragments(shellPage, {
            origin: requestOrigin(req.protocol, req.hostname),
            locales: siteConfig?.locales
          })
        : {}
      const shell = insertIntoAppShell(
        shellPage ? withShellTitle(template, shellPage.title) : template,
        mergeShellFragments(
          robotsShellFragments(siteConfig?.robots),
          analyticsShellFragments(siteConfig?.analytics),
          pageFragments,
          themeShellFragments(siteConfig?.theme)
        )
      )
      const robots = robotsDirective(siteConfig?.robots)
      if (robots) {
        reply.header('X-Robots-Tag', robots)
      }
      return reply
        .code(status)
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(shell)
    } catch (err: any) {
      // -> Nothing to serve means the frontend was never built, which is a setup step rather than a
      //    fault of this request: say which one, since a bare 500 sends people looking in the server
      CARDINAL.logger.error('http', 'cannot serve the app shell', {
        path: appShellPath,
        error: err
      })
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('The frontend has not been built yet. Run `npm run build` in frontend/.\n')
    }
  })
}
