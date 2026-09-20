import { describe, expect, it } from 'vitest'

import routes from './routes.js'

import { buildTestRouter } from '../../test/router.js'

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

    expect(typeof loaded.default).toBe('object')
    expect(typeof loaded.default.setup).toBe('function')
  })
})

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
 * `groups/:id?/:section?` and `users/:id?/:section?` carry as many path segments as a `:siteid/...`
 * route once their optional params are populated, so the negative cases below matter as much as the
 * positive ones: site-scoping must come from `meta.siteScoped`, never from path shape.
 */
describe('admin site-scoped route meta (OpenProject #3343)', () => {
  const adminRoute = routes.find((route) => route.path === '/_admin')
  const siteChildren = adminRoute.children

  const SITE_SCOPED_PATHS = [
    ':siteid/general',
    ':siteid/analytics',
    ':siteid/approvals',
    ':siteid/blocks',
    ':siteid/editors',
    ':siteid/glossary',
    ':siteid/locale',
    ':siteid/login',
    ':siteid/navigation',
    ':siteid/pages',
    ':siteid/pages/deleted',
    ':siteid/storage/:id?',
    ':siteid/comments',
    ':siteid/theme'
  ]

  it.each(SITE_SCOPED_PATHS)('marks %s as site-scoped', (path) => {
    const route = siteChildren.find((r) => r.path === path)
    expect(route).toBeDefined()
    expect(route.meta?.siteScoped).toBe(true)
  })

  it.each(['auth', 'groups/:id?/:section?', 'users/:id?/:section?'])(
    'does not mark %s as site-scoped',
    (path) => {
      const route = siteChildren.find((r) => r.path === path)
      expect(route).toBeDefined()
      expect(route.meta?.siteScoped).toBeFalsy()
    }
  )
})

/**
 * Asserted through `buildTestRouter(routes)` rather than a per-route object lookup: Vue Router
 * merges `meta` across every matched record, and each of these routes nests its real component a
 * level below the `MainLayout.vue` wrapper as an empty-path child -- so what matters is the resolved
 * `route.meta`, not what is declared on the parent route object.
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
    ['/_search', false],
    ['/_error/notfound', false],
    ['/login', false]
  ])('does not mark %s as a content page route', async (path, expected) => {
    await router.push(path)
    expect(Boolean(router.currentRoute.value.meta.contentPage)).toBe(expected)
  })
})
