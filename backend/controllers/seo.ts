import type { FastifyInstance } from 'fastify'
import { chunk } from 'es-toolkit/array'
import { requestOrigin } from '../helpers/common.ts'
import { localizedPagePath, type LocaleRoutingConfig } from '../helpers/localeRouting.ts'
import { guardSiteEnabled } from '../helpers/siteResolution.ts'
import { SITEMAP_CACHE_TTL_MS } from '../models/pages.ts'

/**
 * sitemaps.org's own per-file cap: at most 50,000 `<url>` entries (or 50 MB, whichever comes first —
 * this codebase has never had a page count anywhere near dense enough for the byte cap to bind first).
 * Also, conveniently, the same service's cap on how many `<sitemap>` children a single sitemap index
 * may list, which is why one constant covers both branches below.
 */
const SITEMAP_URL_LIMIT = 50_000

/** The two flags a site's SEO settings hold, as read off `site.config`. */
interface RobotsConfig {
  robots?: { index?: boolean; follow?: boolean }
  sitemap?: boolean
}

/** The columns `models/pages.ts`'s `listPagesForSitemap` returns — the whole of what a `<url>` needs. */
export interface SitemapPage {
  path: string
  locale: string
  updatedAt: Date
}

/**
 * Characters `<loc>` cannot carry literally. A page path can never actually contain one of these — see
 * `rePagePath` in `models/pages.ts` — so this only guards against a stray character in the hostname a
 * request handed over, not anything a page's own path could put here.
 */
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&apos;'
    }
  })
}

/**
 * `robots.txt`'s content, from a site's SEO settings.
 *
 * `robots.txt` has exactly one crawl directive per user-agent block — `Allow`/`Disallow` on a path —
 * and nothing corresponding to "index but don't follow": that distinction belongs to a page's own
 * `<meta name="robots">` tag or `X-Robots-Tag` header, not the file a crawler reads before it has
 * fetched a single page. So both settings gate the same line rather than each getting one of its own:
 * the site is crawlable at all only when it may be both indexed and followed, and either flag turned
 * off answers with the single `Disallow: /` that is the only accurate way to say "not this one".
 */
export function buildRobotsTxt(config: RobotsConfig, sitemapUrl: string): string {
  const allowed = config.robots?.index !== false && config.robots?.follow !== false
  const lines = ['User-agent: *', allowed ? 'Allow: /' : 'Disallow: /']
  if (config.sitemap) {
    lines.push('', `Sitemap: ${sitemapUrl}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * `sitemap.xml`'s content, from a site's already-guest-filtered page list.
 *
 * Filtering to what an anonymous reader may see is `listPagesForSitemap`'s job, not this one — by the
 * time a page reaches here it is assumed public, and this only has to lay it out as the sitemap schema
 * wants it.
 */
export function buildSitemapXml(
  baseUrl: string,
  pages: SitemapPage[],
  locales?: LocaleRoutingConfig | null
): string {
  // -> Translations share a path (that is the whole translation link in this data model), so the
  //    hreflang cluster for a page is every row with its path
  const clusters = new Map<string, SitemapPage[]>()
  for (const page of pages) {
    const list = clusters.get(page.path) ?? []
    list.push(page)
    clusters.set(page.path, list)
  }
  const urls = pages
    .map((page) => {
      const loc = escapeXml(`${baseUrl}${localizedPagePath(page.path, page.locale, locales)}`)
      const lastmod = page.updatedAt
        .toTemporalInstant()
        .toZonedDateTimeISO('UTC')
        .toPlainDate()
        .toString()
      const cluster = clusters.get(page.path)!
      // -> Every member of a multi-locale cluster lists every alternate, itself included — the
      //    reciprocity hreflang consumers require. A lone page lists nothing.
      const alternates =
        cluster.length > 1
          ? cluster
              .map(
                (alt) =>
                  `    <xhtml:link rel="alternate" hreflang="${escapeXml(alt.locale)}" href="${escapeXml(`${baseUrl}${localizedPagePath(alt.path, alt.locale, locales)}`)}"/>`
              )
              .join('\n') + '\n'
          : ''
      return `  <url>\n    <loc>${loc}</loc>\n${alternates}    <lastmod>${lastmod}</lastmod>\n  </url>`
    })
    .join('\n')
  const body = urls ? `\n${urls}\n` : '\n'
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${body}</urlset>\n`
}

/**
 * `/sitemap.xml`'s content once a site's page count exceeds `SITEMAP_URL_LIMIT` — sitemaps.org's own
 * index format, one `<sitemap>` per paginated child sitemap. Each `loc` arrives already fully formed
 * (the route builds `${baseUrl}/sitemap.xml?page=N` for each chunk), so this stays as pure a
 * string-assembly function as `buildSitemapXml` above, with no pagination logic of its own.
 */
export function buildSitemapIndexXml(childUrls: string[]): string {
  const entries = childUrls
    .map((url) => `  <sitemap>\n    <loc>${escapeXml(url)}</loc>\n  </sitemap>`)
    .join('\n')
  const body = entries ? `\n${entries}\n` : '\n'
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</sitemapindex>\n`
}

/**
 * Everything `/sitemap.xml` decides based on page count and the `?page=` it was asked for — pulled out
 * of the route itself so it is exercised as a pure function rather than only through a live request,
 * matching this file's own reasoning at the top for why `buildRobotsTxt`/`buildSitemapXml` are pure
 * too. At or under `SITEMAP_URL_LIMIT` this is the flat `<urlset>` a site emits today, unconditionally
 * — an out-of-range `page` for a site that never needed pagination just gets the same flat sitemap
 * back, same as if `page` had been omitted, rather than a 404 for a query string that turned out not
 * to matter. Past the limit, no `page` asks for the `<sitemapindex>` over the paginated children,
 * and a `page` outside `[1, chunk count]` is a 404 rather than silently serving something.
 */
export function paginateSitemap(
  baseUrl: string,
  pages: SitemapPage[],
  locales: LocaleRoutingConfig | null | undefined,
  page: number | undefined
): { xml: string } | { notFound: true } {
  if (pages.length <= SITEMAP_URL_LIMIT) {
    return { xml: buildSitemapXml(baseUrl, pages, locales) }
  }
  const chunks = chunk(pages, SITEMAP_URL_LIMIT)
  if (page === undefined) {
    const childUrls = chunks.map((_, index) => `${baseUrl}/sitemap.xml?page=${index + 1}`)
    return { xml: buildSitemapIndexXml(childUrls) }
  }
  if (!Number.isInteger(page) || page < 1 || page > chunks.length) {
    return { notFound: true }
  }
  return { xml: buildSitemapXml(baseUrl, chunks[page - 1]!, locales) }
}

/**
 * `/robots.txt` and `/sitemap.xml`, per site.
 *
 * Registered at the root, with no prefix: these are conventional root-level file paths, not part of
 * `_`-prefixed server namespace the other controllers occupy. `core/http/siteRouting.ts`'s
 * `RESERVED_ROOT_FILES` / `isPageUrl()` already keep both paths out of the SPA-shell fallback and
 * the page-extension redirect hook, so registering real handlers here is the whole of what is
 * needed — see the comment there.
 *
 * The site is resolved per request the same way `controllers/site.ts` resolves it for a logo or
 * favicon: `getSiteByHostname` against the cached site mappings, never a route param, since a root
 * path carries no site id of its own.
 */
async function routes(app: FastifyInstance) {
  app.get('/robots.txt', async (req, reply) => {
    const site = await WIKI.models.sites.getSiteByHostname({ hostname: req.hostname })
    if (!site) {
      return reply.notFound()
    }
    // -> Resolved by hostname independently of the page/shell hook, so a disabled site's robots
    //    directives stay reachable by direct URL until this stops them the same way
    if (guardSiteEnabled(site, reply)) {
      return reply
    }

    const sitemapUrl = `${requestOrigin(req.protocol, req.hostname)}/sitemap.xml`
    return reply.type('text/plain; charset=utf-8').send(buildRobotsTxt(site.config, sitemapUrl))
  })

  app.get<{ Querystring: { page?: string } }>('/sitemap.xml', async (req, reply) => {
    const site = await WIKI.models.sites.getSiteByHostname({ hostname: req.hostname })
    if (!site || !site.config?.sitemap) {
      return reply.notFound()
    }
    // -> A disabled site's sitemap still enumerates its page paths, which is exactly the kind of
    //    identifying content the other resolved-by-hostname controllers already refuse to leak
    if (guardSiteEnabled(site, reply)) {
      return reply
    }

    const pages = await WIKI.models.pages.listPagesForSitemap(site.id)
    const baseUrl = requestOrigin(req.protocol, req.hostname)
    // -> Past the per-file cap, this route doubles as a sitemap index over `SITEMAP_URL_LIMIT`-sized
    //    child sitemaps, addressed by a `?page=` query string rather than a new root-level filename
    //    (`/sitemap-1.xml`) — `.xml` is a page extension on a default site (see `RESERVED_ROOT_FILES`
    //    in `core/http/siteRouting.ts`), so any root path but the one literal `sitemap.xml` already
    //    reserved there
    //    would be redirected away by the extension-stripping hook before ever reaching a route
    //    registered here. See `paginateSitemap` for the full decision.
    const page = req.query.page === undefined ? undefined : Number.parseInt(req.query.page, 10)
    const result = paginateSitemap(baseUrl, pages, site.config?.locales, page)
    if ('notFound' in result) {
      return reply.notFound()
    }
    // -> The page list itself is cached (`listPagesForSitemap`); this header lets a crawler or a CDN
    //    skip asking again at all within the same window.
    return reply
      .type('application/xml; charset=utf-8')
      .header('Cache-Control', `public, max-age=${Math.floor(SITEMAP_CACHE_TTL_MS / 1000)}`)
      .send(result.xml)
  })
}

export default routes
