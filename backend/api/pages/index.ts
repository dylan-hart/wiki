import type { FastifyInstance } from 'fastify'

import classificationRoutes from './classification.ts'
import collabRoutes from './collab.ts'
import draftRoutes from './drafts.ts'
import exportRoutes from './export.ts'
import historyRoutes from './history.ts'
import importRoutes from './import.ts'
import readRoutes from './read.ts'
import taskRoutes from './tasks.ts'
import versionRoutes from './versions.ts'
import writeRoutes from './write.ts'

/**
 * One resource, split into sub-plugins by responsibility. Each is registered with no prefix of its
 * own: a sub-plugin declares whole paths, so a prefix would move every route it owns.
 */
async function routes(app: FastifyInstance) {
  await app.register(readRoutes)
  await app.register(writeRoutes)
  await app.register(taskRoutes)
  await app.register(importRoutes)
  await app.register(classificationRoutes)
  await app.register(historyRoutes)
  await app.register(versionRoutes)
  await app.register(exportRoutes)
  await app.register(draftRoutes)
  await app.register(collabRoutes)
}

export default routes
