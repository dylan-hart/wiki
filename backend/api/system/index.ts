import type { FastifyInstance } from 'fastify'

import extensionsRoutes from './extensions.ts'
import infoRoutes from './info.ts'
import maintenanceRoutes from './maintenance.ts'
import replicationExportRoutes from './replicationExport.ts'
import settingsRoutes from './settings.ts'
import transferRoutes from './transfer.ts'

/**
 * System API Routes
 *
 * One resource, six sub-plugins by responsibility (API-F5): what the instance IS (`info.ts`), what
 * it is CONFIGURED to do (`settings.ts`), what is INSTALLED (`extensions.ts`), what an operator can
 * DO to a running one (`maintenance.ts`), moving one site's content in and out of it (`transfer.ts`),
 * and exporting a whole-instance replication snapshot (`replicationExport.ts` -- Epic #2437's source
 * side, WP #2489; a deliberately separate archive/feature from `transfer.ts`'s per-site export, not
 * a sixth responsibility folded into it). Every route path, method, schema, `tags` and
 * `config.permissions` is what the single `api/system.ts` declared, and each sub-plugin registers
 * unprefixed, so the mounted table under `/system` is identical.
 *
 * The gzip body parser the archive import needs moves into `transfer.ts` with it: `register()` is a
 * real encapsulation boundary, so it now applies only to those routes instead of the whole
 * resource.
 */
async function routes(app: FastifyInstance) {
  await app.register(infoRoutes)
  await app.register(settingsRoutes)
  await app.register(extensionsRoutes)
  await app.register(maintenanceRoutes)
  await app.register(transferRoutes)
  await app.register(replicationExportRoutes)
}

export default routes
