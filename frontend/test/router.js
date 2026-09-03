import { createMemoryHistory, createRouter } from 'vue-router'

/** What 35 of the 103 hand-rolled route lists carried as their only route. */
const STUB_ROUTE_COMPONENT = { template: '<div />' }

/**
 * The one `createRouter` every suite that needs routing mounts against.
 *
 * 103 call sites in 47 files built this by hand, always on `createMemoryHistory()` (the five
 * `createWebHistory()` outliers in `components/FileManager.test.js` were checked against memory
 * history and behave identically), and 90 of them followed it with the same
 * `router.push(...)` + `await router.isReady()` coda -- without which `useRoute()` still reports the
 * initial `/` at mount time and a route-dependent component renders the wrong branch. That coda is
 * why this is async: awaiting the helper IS awaiting `isReady()`.
 *
 * A bare path string expands into a stub route, which is what 35 of those lists wanted
 * (`{ path: '/', component: { template: '<div />' } }`) and what the 15 `'/:pathMatch(.*)*'`
 * catch-alls wanted. A route object passes through untouched, for the suites that need a real
 * component mounted under `<router-view>` (`pages/Index.test.js`, `pages/Search.test.js`).
 */
export async function createTestRouter(routes = ['/'], initialPath = '/') {
  const router = buildTestRouter(routes)
  router.push(initialPath)
  await router.isReady()
  return router
}

/**
 * The router with no initial navigation at all -- `mount.js`'s `routes` shorthand, which is
 * synchronous, needs the instance before it can navigate. It must push AFTER `mount()` installs the
 * router: `install()` itself starts a navigation to the history's current location, so a push issued
 * before then races that one and (memory history's location not having moved yet, since a push
 * settles asynchronously) loses. Prefer `createTestRouter` anywhere the route has to be resolved
 * before a component reads it.
 */
export function buildTestRouter(routes = ['/']) {
  return createRouter({
    history: createMemoryHistory(),
    routes: routes.map((route) =>
      typeof route === 'string' ? { path: route, component: STUB_ROUTE_COMPONENT } : route
    )
  })
}
