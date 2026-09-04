import type { FastifyInstance } from 'fastify'

import classificationRoutes from './classification.ts'
import collabRoutes from './collab.ts'
import draftRoutes from './drafts.ts'
import exportRoutes from './export.ts'
import historyRoutes from './history.ts'
import importRoutes from './import.ts'
import readRoutes from './read.ts'
import writeRoutes from './write.ts'

/**
 * Pages API Routes
 *
 * One resource, split into sub-plugins by responsibility (API-F5 started this at seven; `drafts.ts`
 * and `collab.ts` are later additions, not part of that original split). Every route path, method,
 * schema, `tags` and permission is exactly what a single file would declare, and each sub-plugin is
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
  await app.register(draftRoutes)
  await app.register(collabRoutes)
}

export default routes
