import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'

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

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
type HttpMethod = (typeof HTTP_METHODS)[number]

interface RecordedRoute {
  method: HttpMethod
  path: string
  options: any
}

/** Records every `app.<method>(path, options, handler)` call a route file's registration makes. */
function createRecordingApp(): { app: any; routes: RecordedRoute[] } {
  const routes: RecordedRoute[] = []
  const app: any = {
    // -> No-ops: registration-time-only calls this check doesn't care about, present just so a
    //    route file's top-level `routes()` body runs to completion without throwing.
    addContentTypeParser: () => {},
    addHook: () => {},
    register: () => app
  }
  for (const method of HTTP_METHODS) {
    app[method] = (routePath: string, options?: any) => {
      routes.push({ method, path: routePath, options })
      return app
    }
  }
  return { app, routes }
}

// A handful of route files touch `WIKI.config` at registration time, not just inside a handler
// closure — `assets.ts`'s upload content-type parser reads `WIKI.config.security?.uploadMaxFileSize`
// to size its body limit. Stub just that, the same way it would resolve mid-boot; nothing here
// executes a handler, so no other `WIKI` member is ever reached.
;(globalThis as any).WIKI ??= { config: {} }

const apiDir = import.meta.dirname

const routeFiles = readdirSync(apiDir)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'index.ts')
  .sort()

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
    const { app, routes } = createRecordingApp()
    const mod = await import(`./${file}`)
    await mod.default(app)

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
