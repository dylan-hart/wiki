import type { FastifyInstance } from 'fastify'

import providerRoutes from './provider.ts'
import siteRoutes from './site.ts'
import strategiesRoutes from './strategies.ts'

/**
 * Three audiences in one resource: `site.ts` is the public per-site login surface, `provider.ts`
 * the external identity-provider redirect flow, `strategies.ts` the `manage:system` administration
 * of which strategies exist. Each registers unprefixed, since a sub-plugin declares whole paths.
 */
async function routes(app: FastifyInstance) {
  await app.register(siteRoutes)
  await app.register(providerRoutes)
  await app.register(strategiesRoutes)
}

export default routes
