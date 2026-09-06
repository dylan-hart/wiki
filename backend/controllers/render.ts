import type { FastifyInstance } from 'fastify'

/**
 * The page a headless browser loads in order to render markdown for the server.
 *
 * Nothing but a host for the frontend's renderer bundle — it holds no data, reads nothing and
 * displays nothing. `models/renderQueue.ts` navigates here, waits for `__wikiRenderReady` and calls
 * `__wikiRender` with the content to render.
 */
const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cardinal.js Renderer</title>
</head>
<body>
<script type="module" src="/_assets/renderer.js"></script>
</body>
</html>
`

/**
 * _render Routes
 *
 * Only ever fetched over the loopback interface by this instance's own headless browser, but served
 * like the other static shells rather than gated: there is nothing here to protect, and a session the
 * browser does not have could not be checked anyway.
 *
 * No `enforceApiKeySite()` call belongs here (OpenProject #2201's enumeration named this file, but
 * this route resolves no site at all — the fixed shell below is identical for every site, and the
 * headless browser that fetches it carries no API key). The actual per-page render happens inside
 * that headless browser via `models/renderQueue.ts`'s own `page.evaluate()`, never as a second HTTP
 * request back through this server.
 */
async function routes(app: FastifyInstance) {
  app.get('/', async (_req, reply) => {
    // -> The bundle it pulls in is hashed and immutable, but this page must not be, or a rebuilt
    //    frontend would keep rendering through the previous one
    reply.header('Cache-Control', 'no-store')
    return reply.type('text/html; charset=utf-8').send(SHELL)
  })
}

export default routes
