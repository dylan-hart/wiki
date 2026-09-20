import type { FastifyInstance } from 'fastify'

/**
 * The page a headless browser loads in order to render markdown for the server: nothing but a host
 * for the frontend's renderer bundle. `models/renderQueue.ts` navigates here, waits for
 * `__wikiRenderReady` and calls `__wikiRender` with the content to render.
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
 * Only ever fetched over the loopback interface by this instance's own headless browser, but served
 * like the other static shells rather than gated: there is nothing here to protect, and a session the
 * browser does not have could not be checked anyway.
 */
async function routes(app: FastifyInstance) {
  app.get('/', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return reply.type('text/html; charset=utf-8').send(SHELL)
  })
}

export default routes
