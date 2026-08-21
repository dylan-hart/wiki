import type { FastifyInstance } from 'fastify'
import { requestOrigin, localizedPagePath, type LocaleRoutingConfig } from '../helpers/common.ts'

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
 * `/robots.txt` and `/sitemap.xml`, per site.
 *
 * Registered at the root, with no prefix: these are conventional root-level file paths, not part of
 * `_`-prefixed server namespace the other controllers occupy. `index.ts`'s `RESERVED_ROOT_FILES` /
 * `isPageUrl()` already keep both paths out of the SPA-shell fallback and the page-extension redirect
 * hook, so registering real handlers here is the whole of what is needed — see the comment there.
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

    const sitemapUrl = `${requestOrigin(req.protocol, req.hostname)}/sitemap.xml`
    return reply.type('text/plain; charset=utf-8').send(buildRobotsTxt(site.config, sitemapUrl))
  })

  app.get('/sitemap.xml', async (req, reply) => {
    const site = await WIKI.models.sites.getSiteByHostname({ hostname: req.hostname })
    if (!site || !site.config?.sitemap) {
      return reply.notFound()
    }

    const pages = await WIKI.models.pages.listPagesForSitemap(site.id)
    const baseUrl = requestOrigin(req.protocol, req.hostname)
    return reply
      .type('application/xml; charset=utf-8')
      .send(buildSitemapXml(baseUrl, pages, site.config?.locales))
  })
}

export default routes
