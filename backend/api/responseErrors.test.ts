import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  listApiRouteFiles,
  recordRoutesFrom,
  referencesApiError,
  stubWikiForRegistration
} from '../test/routeRecorder.ts'

/**
 * Task 602 (full response-schema accuracy pass across `backend/api/*.ts`) regression coverage.
 *
 * The systematic gap this closes: `index.ts`'s global `preHandler` hook answers 401 (`reply.unauthorized()`,
 * no permissions at all) or 403 (`reply.forbidden()`, holds some permissions but not the route's) for
 * ANY route that declares a non-empty `config.permissions` — before the handler ever runs. That makes
 * 401 and 403 genuinely reachable on every such route, regardless of what the handler itself does, so
 * an accurate `response` block has to declare both, referencing the shared `ApiError` schema
 * (`api/schemas/error.ts`) that `setErrorHandler` actually shapes those replies into.
 *
 * Uses the same recording-stub technique as `routeTags.test.ts` — replaying each file's registration
 * function against a fake `app` that only records `(method, path, options)` — rather than booting a
 * real Fastify instance, for the same reasons documented there.
 *
 * New route files need no edit here: the directory is scanned at test time.
 */

stubWikiForRegistration()

const apiDir = import.meta.dirname
const routeFiles = listApiRouteFiles(apiDir)

test('every route file under api/ was actually found', () => {
  assert.ok(
    routeFiles.length >= 20,
    `expected at least 20 route files, found ${routeFiles.length}: ${routeFiles.join(', ')}`
  )
})

test('every route with a non-empty config.permissions declares 401 and 403 as ApiError', async () => {
  const missing: string[] = []
  let permissionedRoutes = 0

  for (const file of routeFiles) {
    const routes = await recordRoutesFrom(apiDir, file)

    for (const route of routes) {
      const permissions = route.options?.config?.permissions
      if (!Array.isArray(permissions) || permissions.length < 1) {
        continue
      }
      permissionedRoutes++
      const response = route.options?.schema?.response ?? {}
      const label = `${file}: ${route.method.toUpperCase()} ${route.path}`
      if (!referencesApiError(response['401'])) {
        missing.push(`${label} (missing 401)`)
      }
      if (!referencesApiError(response['403'])) {
        missing.push(`${label} (missing 403)`)
      }
    }
  }

  assert.ok(
    permissionedRoutes > 0,
    'expected at least one route with a non-empty config.permissions to have been recorded'
  )
  assert.deepEqual(
    missing,
    [],
    `${missing.length} permissioned route response(s) don't declare 401/403 as ApiError, even though ` +
      `index.ts's global preHandler hook can send both before the handler ever runs:\n${missing.join('\n')}`
  )
})
