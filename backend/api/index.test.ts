import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'
import { siteEnabledPreHandler, SITE_DISABLED_MESSAGE } from '../helpers/common.ts'

/**
 * Structural regression test for task 699 / OpenProject #1587 / #1593: before `siteEnabledPreHandler`
 * existed, `guardSiteEnabled()` was applied by hand at exactly nine call sites, and a dozen-plus other
 * `:siteId` routes across `pages.ts` (GET PAGE, UNLOCK, page history, the export routes), every read
 * route in `tree.ts`, `assets.ts`'s upload/rename/delete, and everything in `comments.ts`/
 * `navigation.ts`/`liveData.ts`/`glossary.ts` answered a disabled site's content indefinitely to a
 * caller that already held its id.
 *
 * In the shape of `routeTags.test.ts`: walks every route file under `api/` (the same discovery — and
 * the same exclusions, `*.test.ts` and `index.ts` itself) and replays each file's registration
 * function against a recording stub, so a route file added later is covered automatically with no
 * edit here. Unlike `routeTags.test.ts`, this does not need to boot a real Fastify app or hand-fill
 * each route's querystring/body schema to get a request as far as the `preHandler` phase:
 * `siteEnabledPreHandler` only ever reads `req.params.siteId`, so it is exercised directly, once per
 * discovered `:siteId` route, against a synthetic `req` built from that route's own path — proving the
 * exact mechanism a real request would go through (`api/index.ts` wires this same function as a
 * plugin-level `addHook('preHandler', ...)`, which Fastify applies to every route registered in that
 * plugin and its children, this file's whole registration list included) without the cost or
 * flakiness of a full HTTP round trip per route.
 */

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
type HttpMethod = (typeof HTTP_METHODS)[number]

interface RecordedRoute {
  method: HttpMethod
  path: string
}

function createRecordingApp(): { app: any; routes: RecordedRoute[] } {
  const routes: RecordedRoute[] = []
  const app: any = {
    addContentTypeParser: () => {},
    addHook: () => {},
    register: () => app
  }
  for (const method of HTTP_METHODS) {
    app[method] = (routePath: string) => {
      routes.push({ method, path: routePath })
      return app
    }
  }
  return { app, routes }
}

// -> `assets.ts`'s content-type parser reads this at registration time; see `routeTags.test.ts`'s own
//    identical stub for the full reasoning.
;(globalThis as any).WIKI ??= { config: {} }

const apiDir = import.meta.dirname

const routeFiles = readdirSync(apiDir)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'index.ts')
  .sort()

/** Every `:name` segment in a route path, in order — `/sites/:siteId/pages/:pageId` -> `['siteId', 'pageId']`. */
function paramNames(routePath: string): string[] {
  return [...routePath.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!)
}

const ENABLED_SITE_ID = 'enabled-site-id'
const DISABLED_SITE_ID = 'disabled-site-id'

/** A stand-in for `FastifyReply` that records the one method `guardSiteEnabled` may call. */
function fakeReply() {
  const forbidden: string[] = []
  const reply: any = {
    forbidden(message: string) {
      forbidden.push(message)
      return reply
    }
  }
  return { reply, forbidden }
}

test('every route file under api/ was actually found', () => {
  assert.ok(
    routeFiles.length >= 20,
    `expected at least 20 route files, found ${routeFiles.length}: ${routeFiles.join(', ')}`
  )
})

test('every :siteId route is forbidden for a disabled site by siteEnabledPreHandler, and passes an enabled one', async () => {
  const previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = {
    sites: {
      [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, isEnabled: true },
      [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, isEnabled: false }
    },
    config: {}
  }

  const siteScopedRoutes: string[] = []
  let totalRoutes = 0

  try {
    for (const file of routeFiles) {
      const { app, routes } = createRecordingApp()
      const mod = await import(`./${file}`)
      await mod.default(app)
      totalRoutes += routes.length

      for (const route of routes) {
        const names = paramNames(route.path)
        if (!names.includes('siteId')) {
          continue
        }
        const label = `${file}: ${route.method.toUpperCase()} ${route.path}`
        siteScopedRoutes.push(label)

        // -> Build a synthetic req.params with every named param resolved -- siteId to the site
        //    under test, everything else to an arbitrary non-empty string, since
        //    siteEnabledPreHandler reads nothing but req.params.siteId.
        const disabledParams: Record<string, string> = {}
        for (const name of names) {
          disabledParams[name] = name === 'siteId' ? DISABLED_SITE_ID : 'x'
        }

        const disabled = fakeReply()
        let disabledDoneCalled = false
        siteEnabledPreHandler({ params: disabledParams } as any, disabled.reply, () => {
          disabledDoneCalled = true
        })
        assert.deepEqual(
          disabled.forbidden,
          [SITE_DISABLED_MESSAGE],
          `${label} did not answer forbidden for a disabled site`
        )
        assert.equal(disabledDoneCalled, false, `${label} called done() despite being forbidden`)

        // -> And the same route must NOT be forbidden for an enabled site -- proves the guard is
        //    actually reading the resolved site's isEnabled flag, not forbidding unconditionally.
        const enabledParams = { ...disabledParams, siteId: ENABLED_SITE_ID }
        const enabled = fakeReply()
        let enabledDoneCalled = false
        siteEnabledPreHandler({ params: enabledParams } as any, enabled.reply, () => {
          enabledDoneCalled = true
        })
        assert.deepEqual(enabled.forbidden, [], `${label} forbade an enabled site`)
        assert.equal(enabledDoneCalled, true, `${label} never called done() for an enabled site`)
      }
    }
  } finally {
    ;(globalThis as any).WIKI = previousWiki
  }

  assert.ok(totalRoutes > 0, 'expected at least one route to have been recorded across all files')
  // -> Sanity floor on the discovery itself: a change that silently stopped matching `:siteId` paths
  //    (a typo'd regex, a route file excluded by mistake) would otherwise make this whole test
  //    vacuously pass with zero routes checked.
  assert.ok(
    siteScopedRoutes.length >= 30,
    `expected at least 30 :siteId-scoped routes, found ${siteScopedRoutes.length}:\n${siteScopedRoutes.join('\n')}`
  )
})
