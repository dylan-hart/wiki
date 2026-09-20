import { createMemoryHistory, createRouter } from 'vue-router'

const STUB_ROUTE_COMPONENT = { template: '<div />' }

/**
 * Awaits `isReady()` after pushing `initialPath` -- without it `useRoute()` still reports the
 * initial `/` at mount time and a route-dependent component renders the wrong branch.
 */
export async function createTestRouter(routes = ['/'], initialPath = '/') {
  const router = buildTestRouter(routes)
  router.push(initialPath)
  await router.isReady()
  return router
}

/**
 * No initial navigation: `mount.js`'s `routes` shorthand is synchronous and needs the instance
 * before it can navigate. That push must come AFTER `mount()` installs the router -- `install()`
 * itself starts a navigation to the history's current location, and an earlier push races it and
 * loses, memory history's location not having moved yet.
 */
export function buildTestRouter(routes = ['/']) {
  return createRouter({
    history: createMemoryHistory(),
    routes: routes.map((route) =>
      typeof route === 'string' ? { path: route, component: STUB_ROUTE_COMPONENT } : route
    )
  })
}
