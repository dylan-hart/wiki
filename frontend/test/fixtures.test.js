import { describe, expect, it } from 'vitest'

import { seedAdmin, seedPage, seedSite, seedUser, stubRouter } from './fixtures.js'

/**
 * The store seeds behind `mountWithApp`'s `stores` option (TEST-F5). Store seeding in this corpus is
 * single-field, not object-literal -- `siteStore.id = 'site-1'` 92 times, `adminStore.currentSiteId
 * = 'site-1'` 15, `pageStore.id = 'page-1'` 11 -- so each seed is the one identity field that
 * repeats, with everything else supplied per call.
 *
 * `stubRouter` collapses the four local definitions with three different defaults (`boot/api.test.js`,
 * and three inside `stores/page.test.js`) into one that carries BOTH `push` and `replace`: the page
 * store reaches for `push` on create and `replace` on move, and a stub missing either fails as a
 * `TypeError` deep inside the action rather than as an assertion.
 */
describe('store seeds', () => {
  it('seedSite defaults to the id 92 call sites assign by hand', () => {
    expect(seedSite()).toEqual({ id: 'site-1' })
  })

  it('seedUser defaults to no permissions at all, since nothing is granted by default', () => {
    expect(seedUser()).toEqual({ permissions: [] })
  })

  it('seedPage defaults to the id the page suites assign by hand', () => {
    expect(seedPage()).toEqual({ id: 'page-1' })
  })

  it('seedAdmin defaults to the current site the admin suites assign by hand', () => {
    expect(seedAdmin()).toEqual({ currentSiteId: 'site-1' })
  })

  it('merges overrides over the defaults', () => {
    expect(seedSite({ id: 'other', hostname: 'wiki.test' })).toEqual({
      id: 'other',
      hostname: 'wiki.test'
    })
    expect(seedUser({ permissions: ['manage:sites'] })).toEqual({ permissions: ['manage:sites'] })
  })

  it("returns a fresh object per call, so one test cannot mutate the next test's seed", () => {
    const first = seedSite()
    first.id = 'mutated'
    expect(seedSite().id).toBe('site-1')
  })
})

describe('stubRouter', () => {
  it('carries the current path as both path and fullPath', () => {
    expect(stubRouter({ path: '/fr/some-page' }).currentRoute.value).toEqual({
      path: '/fr/some-page',
      fullPath: '/fr/some-page'
    })
  })

  it('carries spy push AND replace, the two methods the page store reaches for', () => {
    const router = stubRouter()
    router.push('/x')
    router.replace('/y')
    expect(router.push).toHaveBeenCalledWith('/x')
    expect(router.replace).toHaveBeenCalledWith('/y')
  })

  it('lets a caller override any member, including the spies', () => {
    const push = () => {}
    expect(stubRouter({ push }).push).toBe(push)
  })
})
