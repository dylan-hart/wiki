import type { FastifyInstance } from 'fastify'
import { chunk } from 'es-toolkit/array'
import { requestOrigin } from '../helpers/common.ts'
import { localizedPagePath, type LocaleRoutingConfig } from '../helpers/localeRouting.ts'
import { guardSiteEnabled } from '../helpers/siteResolution.ts'
import { SITEMAP_CACHE_TTL_MS } from '../models/pages.ts'

/** sitemaps.org's per-file cap: at most 50,000 `<url>` entries (its 50 MB cap is not checked). */
const SITEMAP_URL_LIMIT = 50_000

interface RobotsConfig {
  robots?: { index?: boolean; follow?: boolean }
  sitemap?: boolean
}

export interface SitemapPage {
  path: string
  locale: string
  updatedAt: Date
}

/**
 * A page path can never contain one of these (`rePagePath` in `models/pages.ts`), so this only guards
 * against a stray character in the hostname a request handed over.
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
 * `robots.txt` has nothing corresponding to "index but don't follow" — that distinction belongs to a
 * page's `<meta name="robots">` tag or `X-Robots-Tag` header — so both settings gate the same line:
 * either flag turned off answers `Disallow: /`.
 */
export function buildRobotsTxt(config: RobotsConfig, sitemapUrl: string): string {
  const allowed = config.robots?.index !== false
  const lines = ['User-agent: *', allowed ? 'Allow: /' : 'Disallow: /']
  if (config.sitemap) {
    lines.push('', `Sitemap: ${sitemapUrl}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Assumes `pages` is already filtered to what an anonymous reader may see — that is
 * `listPagesForSitemap`'s job, not this one's.
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

export function buildSitemapIndexXml(childUrls: string[]): string {
  const entries = childUrls
    .map((url) => `  <sitemap>\n    <loc>${escapeXml(url)}</loc>\n  </sitemap>`)
    .join('\n')
  const body = entries ? `\n${entries}\n` : '\n'
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</sitemapindex>\n`
}

/**
 * At or under `SITEMAP_URL_LIMIT`, an out-of-range `page` gets the flat sitemap rather than a 404: the
 * query string turned out not to matter.
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
 * Registered at the root, with no prefix: these are conventional root-level file paths.
 * `core/http/siteRouting.ts`'s `RESERVED_ROOT_FILES` is what keeps both out of the SPA-shell fallback
 * and the page-extension redirect hook.
 */
async function routes(app: FastifyInstance) {
  app.get('/robots.txt', async (req, reply) => {
    const site = await CARDINAL.models.sites.getSiteByHostname({ hostname: req.hostname })
    if (!site) {
      return reply.notFound()
    }
    // -> The page/shell hook's disabled-site check does not cover this route
    if (guardSiteEnabled(site, reply)) {
      return reply
    }

    const sitemapUrl = `${requestOrigin(req.protocol, req.hostname)}/sitemap.xml`
    return reply.type('text/plain; charset=utf-8').send(buildRobotsTxt(site.config, sitemapUrl))
  })

  app.get<{ Querystring: { page?: string } }>('/sitemap.xml', async (req, reply) => {
    const site = await CARDINAL.models.sites.getSiteByHostname({ hostname: req.hostname })
    if (!site || !site.config?.sitemap) {
      return reply.notFound()
    }
    // -> A disabled site's sitemap would still enumerate its page paths
    if (guardSiteEnabled(site, reply)) {
      return reply
    }

    const pages = await CARDINAL.models.pages.listPagesForSitemap(site.id)
    const baseUrl = requestOrigin(req.protocol, req.hostname)
    // -> Child sitemaps are addressed by `?page=` rather than a new root-level filename
    //    (`/sitemap-1.xml`): `.xml` is a page extension on a default site, so any root path but the
    //    reserved `sitemap.xml` would be redirected away by the extension-stripping hook
    const page = req.query.page === undefined ? undefined : Number.parseInt(req.query.page, 10)
    const result = paginateSitemap(baseUrl, pages, site.config?.locales, page)
    if ('notFound' in result) {
      return reply.notFound()
    }
    return reply
      .type('application/xml; charset=utf-8')
      .header('Cache-Control', `public, max-age=${Math.floor(SITEMAP_CACHE_TTL_MS / 1000)}`)
      .send(result.xml)
  })
}

export default routes
