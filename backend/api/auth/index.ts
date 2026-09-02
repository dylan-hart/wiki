import type { FastifyInstance } from 'fastify'

import providerRoutes from './provider.ts'
import siteRoutes from './site.ts'
import strategiesRoutes from './strategies.ts'

/**
 * Authentication API Routes
 *
 * Three audiences in one resource (API-F5): `site.ts` is the public per-site login surface a reader
 * meets, `provider.ts` is the external identity-provider redirect flow (and the callback state and
 * error vocabulary it needs), `strategies.ts` is the `manage:system` administration of which
 * strategies exist at all. Every route path, method, schema, `tags` and `config.permissions` is what
 * the single `api/authentication.ts` declared, and each sub-plugin registers unprefixed, so the
 * mounted route table is identical.
 */
async function routes(app: FastifyInstance) {
  await app.register(siteRoutes)
  await app.register(providerRoutes)
  await app.register(strategiesRoutes)
}

export default routes
