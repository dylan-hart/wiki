import { createMemoryHistory, createRouter } from 'vue-router'

const STUB_ROUTE_COMPONENT = { template: '<div />' }

/**
 * The one `createRouter` every suite that needs routing mounts against. Awaits `router.isReady()`
 * after pushing `initialPath` -- without it, `useRoute()` still reports the initial `/` at mount
 * time and a route-dependent component renders the wrong branch.
 *
 * A bare path string expands into a stub route (`{ path, component: STUB_ROUTE_COMPONENT }`); a
 * route object passes through untouched, for a suite that needs a real component mounted under
 * `<router-view>`.
 */
export async function createTestRouter(routes = ['/'], initialPath = '/') {
  const router = buildTestRouter(routes)
  router.push(initialPath)
  await router.isReady()
  return router
}

/**
 * The router with no initial navigation at all -- `mount.js`'s `routes` shorthand needs the
 * instance before it can navigate, since it's synchronous. It must push AFTER `mount()` installs
 * the router: `install()` itself starts a navigation to the history's current location, and a push
 * issued before that races it and loses (memory history's location hasn't moved yet, since a push
 * settles asynchronously). Prefer `createTestRouter` wherever the route must be resolved before a
 * component reads it.
 */
export function buildTestRouter(routes = ['/']) {
  return createRouter({
    history: createMemoryHistory(),
    routes: routes.map((route) =>
      typeof route === 'string' ? { path: route, component: STUB_ROUTE_COMPONENT } : route
    )
  })
}
