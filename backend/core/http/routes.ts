import type { FastifyInstance } from 'fastify'

/**
 * Every route surface this server mounts, and the prefix each answers on.
 *
 * The leading-underscore prefixes here are the list `siteRouting.ts`'s `SERVER_ROUTE_SEGMENTS` has to
 * stay in step with — a prefix added here without an entry there is a URL the app shell will try to
 * answer as a page.
 */
export function registerRoutes(app: FastifyInstance): void {
  app.register(import('../../api/index.ts'), { prefix: '/_api' })
  app.register(import('../../controllers/blocks.ts'), { prefix: '/_blocks/custom' })
  app.register(import('../../controllers/collab.ts'), { prefix: '/_collab' })
  app.register(import('../../controllers/files.ts'), { prefix: '/_files' })
  app.register(import('../../controllers/site.ts'), { prefix: '/_site' })
  app.register(import('../../controllers/icons.ts'), { prefix: '/_icons' })
  // -> The MCP server's HTTP/SSE transport (`mcp/http.ts`) — see that file's doc comment for the
  //    session/auth model. `mcp/stdio.ts` is the other transport, run as its own OS process.
  app.register(import('../../mcp/http.ts'), { prefix: '/_mcp' })
  // -> Deliberate exception to the leading-underscore convention every other line here follows:
  //    Prometheus scrapes a fixed, unprefixed `/metrics`. See `controllers/metrics.ts` for the full
  //    scope decision (task 594).
  app.register(import('../../controllers/metrics.ts'), { prefix: '/metrics' })
  app.register(import('../../controllers/render.ts'), { prefix: '/_render' })
  // -> No prefix: `/robots.txt` and `/sitemap.xml` are root-level files, not part of the `_`-prefixed
  //    server namespace the rest of these occupy. See `siteRouting.ts`'s `RESERVED_ROOT_FILES` /
  //    `isPageUrl()`.
  app.register(import('../../controllers/seo.ts'))
  app.register(import('../../controllers/terminal.ts'), { prefix: '/_terminal' })
  app.register(import('../../controllers/thumb.ts'), { prefix: '/_thumb' })
  app.register(import('../../controllers/user.ts'), { prefix: '/_user' })
}
