import { describe, expect, it } from 'vitest'

import { createTestRouter } from './router.js'

describe('createTestRouter', () => {
  it('expands bare path strings into stub routes', async () => {
    const router = await createTestRouter(['/', '/:pathMatch(.*)*'])
    expect(
      router
        .getRoutes()
        .map((r) => r.path)
        .sort()
    ).toEqual(['/', '/:pathMatch(.*)*'].sort())
  })

  it('passes route objects through unchanged', async () => {
    const component = { template: '<p>real</p>' }
    const router = await createTestRouter([{ path: '/x', component }])
    expect(router.getRoutes()[0].components.default).toBe(component)
  })

  it('accepts a mix of strings and objects', async () => {
    const component = { template: '<p>real</p>' }
    const router = await createTestRouter(['/', { path: '/x', component }])
    expect(router.getRoutes()).toHaveLength(2)
  })

  it('navigates to the initial path and resolves only once the router is ready', async () => {
    const router = await createTestRouter(['/', '/_admin/:section'], '/_admin/general')
    expect(router.currentRoute.value.path).toBe('/_admin/general')
    expect(router.currentRoute.value.params.section).toBe('general')
  })

  it('defaults to a single "/" route sitting at "/"', async () => {
    const router = await createTestRouter()
    expect(router.currentRoute.value.path).toBe('/')
    expect(router.getRoutes()).toHaveLength(1)
  })

  it('uses memory history, so no test needs a real browser location', async () => {
    const router = await createTestRouter(['/', '/other'], '/other')
    await router.push('/')
    expect(router.currentRoute.value.path).toBe('/')
  })
})
