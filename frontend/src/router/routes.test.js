import { describe, expect, it } from 'vitest'

import routes from './routes.js'

import { buildTestRouter } from '../../test/router.js'

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

/**
 * Regression test for OpenProject #2000: `/_inbox` used to redirect to `/_inbox/messages`, an
 * entirely static stub page ("Nothing here yet.") -- the real notification list lives at
 * `/_inbox/watching` (`InboxWatching.vue`), which is also what the header inbox badge's unread count
 * is tracking. The `messages` route/component is deleted outright rather than left dead.
 */
describe('inbox routes', () => {
  const inboxRoute = routes.find((route) => route.path === '/_inbox')
  const inboxChildren = inboxRoute.children

  it('redirects the bare /_inbox to the real notification list, not the deleted stub', () => {
    const indexChild = inboxChildren.find((route) => route.path === '')

    expect(indexChild.redirect).toBe('/_inbox/watching')
  })

  it('no longer registers a messages child route', () => {
    const messagesRoute = inboxChildren.find((route) => route.path === 'messages')

    expect(messagesRoute).toBeUndefined()
  })

  it('still registers the watching route', () => {
    const watchingRoute = inboxChildren.find((route) => route.path === 'watching')

    expect(watchingRoute).toBeDefined()
  })
})

/**
 * Regression test for OpenProject #812: `/_edit/:pagePath?` had no wildcard, so vue-router only ever
 * captured one path segment -- editing a page at a nested path (e.g. "docs/setup") fell through to the
 * catch-all route instead, with `route.params.pagePath` coming back `undefined`.
 *
 * `pagePath` is handed straight to `pageStore.pageEdit({ path })` as a plain string (see `Index.vue`'s
 * route watcher), so the fix uses a custom regex (`(.*)`) rather than the `*` repeat modifier the
 * standard page catch-all route uses below -- `*` would turn the param into an array of segments
 * instead, which `pageEdit` does not expect.
 */
describe('edit route', () => {
  const router = buildTestRouter(routes)

  it('matches a bare /_edit with no pagePath param', async () => {
    await router.push('/_edit')
    expect(router.currentRoute.value.matched.some((r) => r.path === '/_edit/:pagePath(.*)?')).toBe(
      true
    )
    expect(router.currentRoute.value.params.pagePath).toBeUndefined()
  })

  it('matches a single-segment path as a plain string', async () => {
    await router.push('/_edit/about')
    expect(router.currentRoute.value.params.pagePath).toBe('about')
  })

  it('matches a nested, multi-segment path as a single plain string, not an array', async () => {
    await router.push('/_edit/docs/setup/install')
    const { pagePath } = router.currentRoute.value.params
    expect(pagePath).toBe('docs/setup/install')
    expect(Array.isArray(pagePath)).toBe(false)
  })
})

/**
 * Regression coverage for OpenProject #2512: `MainLayout.vue`'s `isSidebarMini` scopes its
 * `!pageStore.navigationId` fallback to `route.meta.contentPage`, so this flag has to actually be
 * true on every route that renders `Index.vue` (and therefore runs a page through
 * `pageStore.pageLoad()`, which is what sets `navigationId`) and false/absent everywhere else --
 * getting either direction wrong would either bring back the mini-sidebar bug the WP fixed, or wrongly
 * apply the content-page fallback to a route that never sets `navigationId` at all.
 *
 * `buildTestRouter(routes)` (not a per-route object lookup) is what's actually asserted against: Vue
 * Router merges `meta` across every matched record for a resolved path, and each of these routes
 * nests its real component a level below the `MainLayout.vue` wrapper as an empty-path child -- so the
 * meta that matters is what `route.meta` resolves to once matched, not merely what's declared on the
 * parent route object in `routes.js`.
 */
describe('content page route meta (OpenProject #2512)', () => {
  const router = buildTestRouter(routes)

  it.each([
    ['/_create', true],
    ['/_create/markdown', true],
    ['/_edit', true],
    ['/_edit/some/nested/page', true],
    ['/some/ordinary/wiki/page', true]
  ])('marks %s as a content page route', async (path, expected) => {
    await router.push(path)
    expect(Boolean(router.currentRoute.value.meta.contentPage)).toBe(expected)
  })

  it.each([
    ['/_graph', false],
    ['/_tags', false],
    ['/_admin', false],
    ['/_admin/dashboard', false],
    ['/_profile', false],
    ['/_inbox', false],
    ['/_search', false],
    ['/_error/notfound', false],
    ['/login', false]
  ])('does not mark %s as a content page route', async (path, expected) => {
    await router.push(path)
    expect(Boolean(router.currentRoute.value.meta.contentPage)).toBe(expected)
  })
})
