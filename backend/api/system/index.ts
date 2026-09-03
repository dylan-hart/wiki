import type { FastifyInstance } from 'fastify'

import extensionsRoutes from './extensions.ts'
import infoRoutes from './info.ts'
import maintenanceRoutes from './maintenance.ts'
import replicationRoutes from './replication.ts'
import settingsRoutes from './settings.ts'
import transferRoutes from './transfer.ts'

/**
 * System API Routes
 *
 * One resource, six sub-plugins by responsibility (API-F5): what the instance IS (`info.ts`), what
 * it is CONFIGURED to do (`settings.ts`), what is INSTALLED (`extensions.ts`), what an operator can
 * DO to a running one (`maintenance.ts`), moving one site's content in and out of it (`transfer.ts`),
 * and wiping the whole instance and replacing it with another instance's snapshot
 * (`replication.ts`). Every route path, method, schema, `tags` and `config.permissions` is what the
 * single `api/system.ts` declared, and each sub-plugin registers unprefixed, so the mounted table
 * under `/system` is identical.
 *
 * The gzip body parser each archive-import route needs is owned by `transfer.ts` and `replication.ts`
 * themselves, each within its own `register()` scope: a real encapsulation boundary, so it applies
 * only to that sub-plugin's own routes rather than the whole resource, and the two coexist without
 * conflict despite parsing the same content types.
 */
async function routes(app: FastifyInstance) {
  await app.register(infoRoutes)
  await app.register(settingsRoutes)
  await app.register(extensionsRoutes)
  await app.register(maintenanceRoutes)
  await app.register(transferRoutes)
  await app.register(replicationRoutes)
}

export default routes
