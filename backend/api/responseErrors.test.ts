import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  listApiRouteFiles,
  recordRoutesFrom,
  referencesApiError,
  stubWikiForRegistration
} from '../test/routeRecorder.ts'

/**
 * `permissionPreHandler` (`core/http/authHooks.ts`) answers 401 or 403 for any route declaring a
 * non-empty `config.permissions`, before the handler runs -- so both are reachable on every such
 * route whatever its handler does, and its `response` block must declare them as `ApiError`.
 * Routes are recorded, not booted, for the reasons `routeTags.test.ts` gives.
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
