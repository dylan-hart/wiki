import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  listApiRouteFiles,
  recordRoutesFrom,
  stubWikiForRegistration
} from '../test/routeRecorder.ts'

/**
 * Guards `hideUntagged: true` in the swagger config (`index.ts`): a route registered without a
 * `tags` array in its schema doesn't error at boot — it just disappears from `/_api`'s Swagger UI
 * with no build-time signal. This walks every route file under `api/` (excluding this directory's
 * own `*.test.ts` files and `index.ts`, which only re-exports the others) and replays each file's
 * registration function against a recording stub instead of a real Fastify instance: booting the
 * genuine app needs the AJV customization `index.ts` installs (a custom `hexcolor` format, an
 * `ajv-formats` plugin) purely to build validators, none of which this check cares about, and
 * `index.ts` itself cannot be imported in a test at all (it runs the full boot sequence, database
 * included, via top-level await). Recording the exact `(path, options)` pair each
 * `app.get/post/put/patch/delete` call makes is what a real Fastify instance would also see —
 * this only skips building working validators/serializers around it, which is enough to see
 * whether `options.schema.tags` was ever supplied.
 *
 * New route files need no edit here: the directory is scanned at test time, so a file added
 * without ever wiring this check up still gets covered by it.
 */

stubWikiForRegistration()

const apiDir = import.meta.dirname
const routeFiles = listApiRouteFiles(apiDir)

test('every route file under api/ was actually found', () => {
  // Sanity check on the scan itself: a typo'd extension filter that silently matched nothing would
  // make every test below vacuously pass.
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
