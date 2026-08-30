import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminSites from './AdminSites.vue'

const SITES = [
  { id: 1, title: 'Docs', hostname: 'docs.example.com', isEnabled: true },
  { id: 2, title: 'Catch-all', hostname: '*', isEnabled: false }
]

async function mountPage() {
  setActivePinia(createPinia())

  API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve(SITES) }))

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/_admin/sites', component: { template: '<div />' } }]
  })
  router.push('/_admin/sites')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(AdminSites, {
    global: { plugins: [router, i18n] }
  })
  await vi.waitUntil(() => API_CLIENT.get.mock.calls.length >= 1)
  await wrapper.vm.$nextTick()

  return { wrapper }
}

/**
 * OpenProject #1990: a site's hostname was rendered as an inert chip -- no href, no click
 * handler -- so an admin who just created a new site had no way to open it short of retyping the
 * hostname into the address bar by hand.
 */
describe('AdminSites hostname links (OpenProject #1990)', () => {
  it('links a named hostname row to that hostname', async () => {
    const { wrapper } = await mountPage()

    const links = wrapper.findAll('a.site-hostname-link')
    expect(links).toHaveLength(2)
    expect(links[0].attributes('href')).toBe('//docs.example.com')
    expect(links[0].attributes('target')).toBe('_blank')
  })

  it('links the catch-all (`*`) row to the current host rather than "//*"', async () => {
    const { wrapper } = await mountPage()

    const links = wrapper.findAll('a.site-hostname-link')
    expect(links[1].attributes('href')).toBe(`//${window.location.host}`)
    expect(links[1].attributes('href')).not.toContain('*')
  })

  it('renders a link for a disabled site too', async () => {
    const { wrapper } = await mountPage()

    // SITES[1] (the catch-all row) is isEnabled: false -- it should still be openable.
    const links = wrapper.findAll('a.site-hostname-link')
    expect(links[1].attributes('href')).toBeTruthy()
  })

  it('renders a dedicated open button per row, in addition to the hostname chip link', async () => {
    const { wrapper } = await mountPage()

    // -> Two links open docs.example.com: the hostname chip itself, and a separate action-group
    //    button beside Edit/Delete.
    const links = wrapper.findAll('a[href="//docs.example.com"]')
    expect(links).toHaveLength(2)
  })
})
