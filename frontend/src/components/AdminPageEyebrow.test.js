import { describe, expect, it } from 'vitest'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import AdminPageEyebrow from './AdminPageEyebrow.vue'

/**
 * OpenProject #3343 — `sectionKey` used to infer site-scoping from `route.path`'s segment count
 * (`/_admin/<siteId>/<page>` being the only shape with a segment between the prefix and the page
 * name). `groups/:id?/:section?` and `users/:id?/:section?` (Users pages, not site-scoped) carry
 * just as many segments once their optional params are populated, e.g. `/_admin/groups/5/members`
 * misread as site-scoped. The fix reads `route.meta.siteScoped`, set explicitly on the 13
 * `:siteid/...` routes in `router/routes.js`, instead of parsing the path.
 */

const STUB = { template: '<div />' }

const ROUTES = [
  { path: '/_admin/dashboard', component: STUB },
  { path: '/_admin/sites', component: STUB },
  { path: '/_admin/:siteid/general', component: STUB, meta: { siteScoped: true } },
  { path: '/_admin/:siteid/storage/:id?', component: STUB, meta: { siteScoped: true } },
  { path: '/_admin/auth', component: STUB },
  { path: '/_admin/groups/:id?/:section?', component: STUB },
  { path: '/_admin/users/:id?/:section?', component: STUB },
  { path: '/_admin/system', component: STUB }
]

async function mountAt(path) {
  const router = await createTestRouter(ROUTES, path)
  return mountWithApp(AdminPageEyebrow, {
    router,
    messages: {
      'admin.eyebrow': 'Admin',
      'admin.nav.overview': 'Overview',
      'admin.nav.site': 'Site',
      'admin.nav.system': 'System',
      'admin.nav.users': 'Users'
    }
  })
}

describe('AdminPageEyebrow', () => {
  it('reads meta.siteScoped for a site-scoped route', async () => {
    const { wrapper } = await mountAt('/_admin/site-1/general')
    expect(wrapper.text()).toBe('Admin · Site')
  })

  it('reads meta.siteScoped for a site-scoped route with its own optional segment', async () => {
    const { wrapper } = await mountAt('/_admin/site-1/storage/42')
    expect(wrapper.text()).toBe('Admin · Site')
  })

  it('does not misclassify groups/:id?/:section? as site-scoped once both params are populated', async () => {
    // -> The exact regression: /_admin/groups/5/members used to read as site-scoped by segment count.
    const { wrapper } = await mountAt('/_admin/groups/5/members')
    expect(wrapper.text()).toBe('Admin · Users')
  })

  it('does not misclassify users/:id?/:section? as site-scoped once both params are populated', async () => {
    const { wrapper } = await mountAt('/_admin/users/5/groups')
    expect(wrapper.text()).toBe('Admin · Users')
  })

  it('classifies groups with no optional params as Users', async () => {
    const { wrapper } = await mountAt('/_admin/groups')
    expect(wrapper.text()).toBe('Admin · Users')
  })

  it('classifies auth as Users', async () => {
    const { wrapper } = await mountAt('/_admin/auth')
    expect(wrapper.text()).toBe('Admin · Users')
  })

  it('classifies dashboard as Overview', async () => {
    const { wrapper } = await mountAt('/_admin/dashboard')
    expect(wrapper.text()).toBe('Admin · Overview')
  })

  it('classifies sites as Overview', async () => {
    const { wrapper } = await mountAt('/_admin/sites')
    expect(wrapper.text()).toBe('Admin · Overview')
  })

  it('classifies an unrecognized page as System', async () => {
    const { wrapper } = await mountAt('/_admin/system')
    expect(wrapper.text()).toBe('Admin · System')
  })

  it('renders the bare area with no router at all', () => {
    const { wrapper } = mountWithApp(AdminPageEyebrow, {
      messages: { 'admin.eyebrow': 'Admin' }
    })
    expect(wrapper.text()).toBe('Admin')
  })
})
