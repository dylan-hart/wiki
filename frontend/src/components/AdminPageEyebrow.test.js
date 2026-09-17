import { describe, expect, it } from 'vitest'

import AdminPageEyebrow from './AdminPageEyebrow.vue'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Feature #3330 / OpenProject #3332: the eyebrow's group derivation used to be a structural
 * inference -- any `/_admin/<siteId>/<page>` route (one extra segment ahead of the page name) was
 * unconditionally the "Site" group, everything else split between "Users" and "System" by name. That
 * worked only because the old 3-group taxonomy was exactly "site-scoped = Site, else Users/System" --
 * a 1:1 split between route shape and group. The 8-group taxonomy breaks that split (Content, Editing
 * Tools and Integrations & Automation each mix site-scoped and non-site-scoped pages), so these tests
 * exercise the explicit page-name -> group table directly through real routes rather than assuming
 * shape still implies group.
 *
 * OpenProject #3343: the same segment-count shape was also, separately, how the component used to
 * decide whether to strip a leading `<siteId>` segment before the page-name lookup -- which
 * misclassified `groups/:id?/:section?`/`users/:id?/:section?` as site-scoped once their optional
 * params were populated (e.g. `/_admin/groups/5/members`). The routes below carry the real
 * `meta.siteScoped` flag from `router/routes.js` (rather than a catch-all stub) specifically so this
 * suite exercises that fix, not just the group table.
 *
 * Mock `messages` stand in for `backend/locales/en.json`'s real `admin.nav.*` keys -- this component
 * only *consumes* those keys (owned by sibling Task #3331, see Epic 336 comment #9741) and must not
 * add its own entries to that file, including for test fixtures.
 */
const MESSAGES = {
  admin: {
    eyebrow: 'Admin',
    nav: {
      overview: 'Overview',
      content: 'Content',
      siteConfiguration: 'Site',
      editingTools: 'Editing & Search',
      usersAccess: 'Access',
      monitoringHealth: 'Monitoring',
      integrationsAutomation: 'Integrations',
      securityAdvanced: 'Advanced'
    }
  }
}

const SITE_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
const STUB = { template: '<div />' }
const scoped = (path) => ({ path, component: STUB, meta: { siteScoped: true } })
const unscoped = (path) => ({ path, component: STUB })

// Mirrors `router/routes.js`'s real `/_admin` children -- path and `meta.siteScoped` only, no lazy
// component imports (this suite never renders one, only reads `route.path`/`route.meta`).
const ROUTES = [
  unscoped('/_admin/dashboard'),
  unscoped('/_admin/sites'),
  scoped('/_admin/:siteid/pages'),
  scoped('/_admin/:siteid/pages/deleted'),
  scoped('/_admin/:siteid/glossary'),
  scoped('/_admin/:siteid/comments'),
  scoped('/_admin/:siteid/approvals'),
  unscoped('/_admin/classification'),
  scoped('/_admin/:siteid/general'),
  scoped('/_admin/:siteid/theme'),
  scoped('/_admin/:siteid/navigation'),
  scoped('/_admin/:siteid/locale'),
  scoped('/_admin/:siteid/login'),
  scoped('/_admin/:siteid/storage/:id?'),
  scoped('/_admin/:siteid/editors'),
  scoped('/_admin/:siteid/blocks'),
  unscoped('/_admin/search'),
  unscoped('/_admin/icons'),
  unscoped('/_admin/auth'),
  unscoped('/_admin/groups/:id?/:section?'),
  unscoped('/_admin/users/:id?/:section?'),
  unscoped('/_admin/audit'),
  unscoped('/_admin/system'),
  unscoped('/_admin/metrics'),
  unscoped('/_admin/pageviews'),
  unscoped('/_admin/livelog'),
  unscoped('/_admin/cluster'),
  unscoped('/_admin/replication'),
  unscoped('/_admin/scheduler'),
  unscoped('/_admin/api'),
  unscoped('/_admin/webhooks'),
  unscoped('/_admin/extensions'),
  unscoped('/_admin/mail'),
  scoped('/_admin/:siteid/analytics'),
  unscoped('/_admin/security'),
  unscoped('/_admin/flags'),
  unscoped('/_admin/utilities'),
  unscoped('/:pathMatch(.*)*')
]

async function mountAt(path) {
  const router = await createTestRouter(ROUTES, path)
  return mountWithApp(AdminPageEyebrow, { router, messages: MESSAGES }).wrapper
}

describe('AdminPageEyebrow group derivation', () => {
  it.each([
    ['/_admin/dashboard', 'Overview'],
    ['/_admin/sites', 'Overview'],
    [`/_admin/${SITE_ID}/pages`, 'Content'],
    [`/_admin/${SITE_ID}/pages/deleted`, 'Content'],
    [`/_admin/${SITE_ID}/glossary`, 'Content'],
    [`/_admin/${SITE_ID}/comments`, 'Content'],
    [`/_admin/${SITE_ID}/approvals`, 'Content'],
    ['/_admin/classification', 'Content'],
    [`/_admin/${SITE_ID}/general`, 'Site'],
    [`/_admin/${SITE_ID}/theme`, 'Site'],
    [`/_admin/${SITE_ID}/navigation`, 'Site'],
    [`/_admin/${SITE_ID}/locale`, 'Site'],
    [`/_admin/${SITE_ID}/login`, 'Site'],
    [`/_admin/${SITE_ID}/storage`, 'Site'],
    [`/_admin/${SITE_ID}/editors`, 'Editing & Search'],
    [`/_admin/${SITE_ID}/blocks`, 'Editing & Search'],
    ['/_admin/search', 'Editing & Search'],
    ['/_admin/icons', 'Editing & Search'],
    ['/_admin/auth', 'Access'],
    ['/_admin/groups', 'Access'],
    ['/_admin/users', 'Access'],
    ['/_admin/audit', 'Access'],
    ['/_admin/system', 'Monitoring'],
    ['/_admin/metrics', 'Monitoring'],
    ['/_admin/pageviews', 'Monitoring'],
    ['/_admin/livelog', 'Monitoring'],
    ['/_admin/cluster', 'Monitoring'],
    ['/_admin/replication', 'Monitoring'],
    ['/_admin/scheduler', 'Monitoring'],
    ['/_admin/api', 'Integrations'],
    ['/_admin/webhooks', 'Integrations'],
    ['/_admin/extensions', 'Integrations'],
    ['/_admin/mail', 'Integrations'],
    [`/_admin/${SITE_ID}/analytics`, 'Integrations'],
    ['/_admin/security', 'Access'],
    ['/_admin/flags', 'Advanced'],
    ['/_admin/utilities', 'Advanced']
  ])('renders "Admin · %s" for %s', async (path, group) => {
    const wrapper = await mountAt(path)

    expect(wrapper.text()).toBe(`Admin · ${group}`)
  })

  it('renders the bare `/_admin` redirect as the dashboard (Overview)', async () => {
    const wrapper = await mountAt('/_admin')

    expect(wrapper.text()).toBe('Admin · Overview')
  })

  it('renders only the area, with no group, for an unrecognized admin route', async () => {
    const wrapper = await mountAt('/_admin/not-a-real-page')

    expect(wrapper.text()).toBe('Admin')
  })

  it('renders only the area, with no group, when mounted with no router at all', () => {
    const wrapper = mountWithApp(AdminPageEyebrow, { messages: MESSAGES }).wrapper

    expect(wrapper.text()).toBe('Admin')
  })

  describe('OpenProject #3343 regression: meta.siteScoped, not segment count', () => {
    it('does not misclassify groups/:id?/:section? as site-scoped once both optional params are populated', async () => {
      // -> The exact regression: /_admin/groups/5/members used to read as site-scoped by segment
      // count, stripping "5" as a siteId and looking up "members" (no match) instead of "groups".
      const wrapper = await mountAt('/_admin/groups/5/members')

      expect(wrapper.text()).toBe('Admin · Access')
    })

    it('does not misclassify users/:id?/:section? as site-scoped once both optional params are populated', async () => {
      const wrapper = await mountAt('/_admin/users/5/groups')

      expect(wrapper.text()).toBe('Admin · Access')
    })
  })
})
