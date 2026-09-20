import type { FastifyInstance } from 'fastify'

import extensionsRoutes from './extensions.ts'
import infoRoutes from './info.ts'
import maintenanceRoutes from './maintenance.ts'
import replicationExportRoutes from './replicationExport.ts'
import replicationRoutes from './replication.ts'
import settingsRoutes from './settings.ts'
import transferRoutes from './transfer.ts'

/**
 * Sub-plugins register unprefixed: each declares whole paths. `replicationExport.ts` and
 * `replication.ts` move a whole-instance snapshot, deliberately separate from `transfer.ts`'s
 * per-site export/import. `transfer.ts` and `replication.ts` each own their gzip body parser inside
 * their own `register()` scope, which is what lets two parsers for the same content types coexist.
 */
async function routes(app: FastifyInstance) {
  await app.register(infoRoutes)
  await app.register(settingsRoutes)
  await app.register(extensionsRoutes)
  await app.register(maintenanceRoutes)
  await app.register(transferRoutes)
  await app.register(replicationExportRoutes)
  await app.register(replicationRoutes)
}

export default routes
