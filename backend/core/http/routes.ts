import type { FastifyInstance } from 'fastify'

/**
 * The leading-underscore prefixes here are the list `siteRouting.ts`'s `SERVER_ROUTE_SEGMENTS` has
 * to stay in step with — a prefix added here without an entry there is a URL the app shell will try
 * to answer as a page.
 */
export function registerRoutes(app: FastifyInstance): void {
  app.register(import('../../api/index.ts'), { prefix: '/_api' })
  app.register(import('../../controllers/blocks.ts'), { prefix: '/_blocks/custom' })
  app.register(import('../../controllers/collab.ts'), { prefix: '/_collab' })
  app.register(import('../../controllers/files.ts'), { prefix: '/_files' })
  app.register(import('../../controllers/site.ts'), { prefix: '/_site' })
  app.register(import('../../controllers/icons.ts'), { prefix: '/_icons' })
  app.register(import('../../mcp/http.ts'), { prefix: '/_mcp' })
  // -> Deliberate exception to the leading-underscore convention: Prometheus scrapes a fixed,
  //    unprefixed `/metrics`.
  app.register(import('../../controllers/metrics.ts'), { prefix: '/metrics' })
  app.register(import('../../controllers/pageScripts.ts'), { prefix: '/_pages' })
  app.register(import('../../controllers/render.ts'), { prefix: '/_render' })
  // -> No prefix: `/robots.txt` and `/sitemap.xml` are root-level files, kept out of the page tree
  //    by `siteRouting.ts`'s `RESERVED_ROOT_FILES`.
  app.register(import('../../controllers/seo.ts'))
  app.register(import('../../controllers/terminal.ts'), { prefix: '/_terminal' })
  app.register(import('../../controllers/thumb.ts'), { prefix: '/_thumb' })
  app.register(import('../../controllers/user.ts'), { prefix: '/_user' })
}
