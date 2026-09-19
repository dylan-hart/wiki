import type { FastifyInstance } from 'fastify'

import adminRoutes from './admin.ts'
import profileRoutes from './profile.ts'

/**
 * `admin.ts` is what somebody with `read:users`/`manage:users` does to other people's accounts,
 * `profile.ts` what any logged in user does to their own. Both are registered unprefixed, since each
 * declares whole paths. `register()` is a real encapsulation boundary, which is what keeps
 * `profile.ts`'s `requireSessionUser` preHandler off every `admin.ts` route.
 */
async function routes(app: FastifyInstance) {
  await app.register(adminRoutes)
  await app.register(profileRoutes)
}

export default routes
