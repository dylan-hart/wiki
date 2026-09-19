import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  listApiRouteFiles,
  recordRoutesFrom,
  stubWikiForRegistration
} from '../test/routeRecorder.ts'

/**
 * Guards `hideUntagged: true` (`core/http/openapi.ts`): a route registered without `tags` doesn't
 * error at boot, it just disappears from `/_api`'s Swagger UI. Each route file's registration is
 * replayed against a recording stub rather than a real Fastify instance: the real app needs
 * `createHttpApp()`'s AJV formats purely to build validators this check doesn't care about, and
 * `index.ts` cannot be imported in a test at all (it runs the full boot sequence via top-level
 * await).
 */

stubWikiForRegistration()

const apiDir = import.meta.dirname
const routeFiles = listApiRouteFiles(apiDir)

test('every route file under api/ was actually found', () => {
  // A scan that silently matched nothing would make the test below pass vacuously.
  assert.ok(
    routeFiles.length >= 20,
    `expected at least 20 route files, found ${routeFiles.length}: ${routeFiles.join(', ')}`
  )
})

test('every registered route declares tags, so it survives hideUntagged', async () => {
  const missing: string[] = []
  let totalRoutes = 0

  for (const file of routeFiles) {
    const routes = await recordRoutesFrom(apiDir, file)

    totalRoutes += routes.length
    for (const route of routes) {
      const tags = route.options?.schema?.tags
      if (!Array.isArray(tags) || tags.length === 0) {
        missing.push(`${file}: ${route.method.toUpperCase()} ${route.path}`)
      }
    }
  }

  assert.ok(totalRoutes > 0, 'expected at least one route to have been recorded across all files')
  assert.deepEqual(
    missing,
    [],
    `${missing.length} route(s) have no schema.tags and will silently disappear from /_api ` +
      `(hideUntagged: true in index.ts):\n${missing.join('\n')}`
  )
})
