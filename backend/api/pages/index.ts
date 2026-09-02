import type { FastifyInstance } from 'fastify'

import classificationRoutes from './classification.ts'
import exportRoutes from './export.ts'
import historyRoutes from './history.ts'
import importRoutes from './import.ts'
import readRoutes from './read.ts'
import writeRoutes from './write.ts'

/**
 * Pages API Routes
 *
 * One resource, six sub-plugins by responsibility (API-F5). Every route path, method, schema,
 * `tags` and permission is exactly what the single `api/pages.ts` declared, and each sub-plugin is
 * registered with no prefix of its own — the mounted route table is identical either way.
 *
 * The one thing the split changes, deliberately: `import.ts` carries the catch-all `'*'` body
 * parser and the `@fastify/multipart` registration its two upload routes need, and `register()` is a
 * real encapsulation boundary, so those now apply to those two routes alone rather than to every
 * page route in the file. Nothing else here parsed a body any way but as JSON, which Fastify's own
 * built-in parser claims ahead of a catch-all regardless.
 */
async function routes(app: FastifyInstance) {
  await app.register(readRoutes)
  await app.register(writeRoutes)
  await app.register(importRoutes)
  await app.register(classificationRoutes)
  await app.register(historyRoutes)
  await app.register(exportRoutes)
}

export default routes
