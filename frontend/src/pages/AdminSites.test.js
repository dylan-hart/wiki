import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import AdminSites from './AdminSites.vue'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

const SITES = [
  { id: 1, title: 'Docs', hostname: 'docs.example.com', isEnabled: true },
  { id: 2, title: 'Catch-all', hostname: '*', isEnabled: false }
]

async function mountPage() {
  API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve(SITES) }))

  const router = await createTestRouter(['/_admin/sites'], '/_admin/sites')

  const { wrapper } = mountWithApp(AdminSites, { router })
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

/**
 * OpenProject #1929: `/admin/sites` names a multi-site-administration concept this fork invented (no
 * upstream Wiki.js docs site can describe it), so the `docsBase`-based help button was deleted rather
 * than left pointing at a page that does not exist. Reads the raw source rather than mounting the
 * component -- a full mount is out of proportion for asserting that some markup is simply gone -- so
 * this also guards against the button quietly being reintroduced.
 */
const source = readFileSync(join(import.meta.dirname, 'AdminSites.vue'), 'utf-8')

describe('AdminSites help link', () => {
  it('has no docsBase-based help/docs button', () => {
    expect(source).not.toContain('docsBase')
  })
})
