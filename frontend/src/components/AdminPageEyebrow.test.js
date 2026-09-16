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
      siteConfiguration: 'Site Configuration',
      editingTools: 'Editing Tools',
      usersAccess: 'Users & Access',
      monitoringHealth: 'Monitoring & Health',
      integrationsAutomation: 'Integrations & Automation',
      securityAdvanced: 'Security & Advanced'
    }
  }
}

const SITE_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'

async function mountAt(path) {
  const router = await createTestRouter(['/:pathMatch(.*)*'], path)
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
    [`/_admin/${SITE_ID}/general`, 'Site Configuration'],
    [`/_admin/${SITE_ID}/theme`, 'Site Configuration'],
    [`/_admin/${SITE_ID}/navigation`, 'Site Configuration'],
    [`/_admin/${SITE_ID}/locale`, 'Site Configuration'],
    [`/_admin/${SITE_ID}/login`, 'Site Configuration'],
    [`/_admin/${SITE_ID}/storage`, 'Site Configuration'],
    [`/_admin/${SITE_ID}/editors`, 'Editing Tools'],
    [`/_admin/${SITE_ID}/blocks`, 'Editing Tools'],
    ['/_admin/search', 'Editing Tools'],
    ['/_admin/icons', 'Editing Tools'],
    ['/_admin/auth', 'Users & Access'],
    ['/_admin/groups', 'Users & Access'],
    ['/_admin/users', 'Users & Access'],
    ['/_admin/audit', 'Users & Access'],
    ['/_admin/system', 'Monitoring & Health'],
    ['/_admin/metrics', 'Monitoring & Health'],
    ['/_admin/pageviews', 'Monitoring & Health'],
    ['/_admin/livelog', 'Monitoring & Health'],
    ['/_admin/cluster', 'Monitoring & Health'],
    ['/_admin/replication', 'Monitoring & Health'],
    ['/_admin/scheduler', 'Monitoring & Health'],
    ['/_admin/api', 'Integrations & Automation'],
    ['/_admin/webhooks', 'Integrations & Automation'],
    ['/_admin/extensions', 'Integrations & Automation'],
    ['/_admin/mail', 'Integrations & Automation'],
    [`/_admin/${SITE_ID}/analytics`, 'Integrations & Automation'],
    ['/_admin/security', 'Security & Advanced'],
    ['/_admin/flags', 'Security & Advanced'],
    ['/_admin/utilities', 'Security & Advanced']
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
})
