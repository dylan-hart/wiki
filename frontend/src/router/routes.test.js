import { describe, expect, it } from 'vitest'

import routes from './routes.js'

/**
 * Regression test for wiring the admin Comments page into the router (Task 614, Feature 394 --
 * "Admin comments management UI rebuild"). Before this the `:siteid/comments` child route did not
 * exist at all, so the sidebar link in `AdminLayout.vue` pointed at a path Vue Router had no match
 * for -- following it landed on the catch-all rather than a rendering page.
 */
describe('admin routes', () => {
  const adminRoute = routes.find((route) => route.path === '/_admin')
  const siteChildren = adminRoute.children

  it('registers a per-site comments route alongside the other :siteid/* admin routes', () => {
    const commentsRoute = siteChildren.find((route) => route.path === ':siteid/comments')

    expect(commentsRoute).toBeDefined()
  })

  it('lazily loads a real component (not undefined/404) for the comments route', async () => {
    const commentsRoute = siteChildren.find((route) => route.path === ':siteid/comments')

    const loaded = await commentsRoute.component()

    // -> `typeof loaded.default.setup` (a `<script setup>` component), not `.data` (the pre-3.x
    //    Options API shape this page was rewritten out of by Task 621) -- updated here since Task
    //    621 changed the component's shape without touching this assertion.
    expect(typeof loaded.default).toBe('object')
    expect(typeof loaded.default.setup).toBe('function')
  })
})
