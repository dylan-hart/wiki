import type { FastifyInstance } from 'fastify'

import adminRoutes from './admin.ts'
import profileRoutes from './profile.ts'

/**
 * Users API Routes
 *
 * Two audiences that shared nothing but a file (API-F5): `admin.ts` is what somebody with
 * `read:users`/`manage:users` does to OTHER people's accounts, `profile.ts` is what any logged in
 * user does to their own. Both are registered here with no prefix of their own, so the mounted route
 * table under `/users` is exactly what the single `api/users.ts` produced.
 *
 * The split is what lets `profile.ts` carry one `requireSessionUser` preHandler for its whole
 * surface instead of the same four-line session check at the top of all 21 of its handlers —
 * `register()` is a real encapsulation boundary, so that hook never reaches an `admin.ts` route.
 * The avatar content-type parser moves with it, for the same reason.
 */
async function routes(app: FastifyInstance) {
  await app.register(adminRoutes)
  await app.register(profileRoutes)
}

export default routes
