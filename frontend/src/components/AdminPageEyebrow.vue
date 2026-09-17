<template>
  <div class="admin-page-eyebrow">{{ label }}</div>
</template>

<script setup>
/*
  The overline above an admin page's title -- `ADMIN · CONTENT`, `ADMIN · SECURITY & ADVANCED` --
  which is what the design puts there (`ui-redesign/Cardinal Wiki - Admin 3x.dc.html`): the area, then
  the section of it the reader is standing in, in the accent, above a title that names only the page.

  Derived from the route rather than declared page by page, so the 38 admin pages cannot disagree with
  the sidebar about which group they belong to. The eight groups are exactly the sidebar's own
  (`AdminLayout.vue`, Feature #3330's reorganization): the two entries above the first section header
  are the overview, and every other page is looked up by name in `PAGE_GROUPS` below.

  A site-scoped page (`/_admin/<siteId>/<page>`) has one extra path segment ahead of the page name, so
  extracting the page name needs to know whether to strip it. This used to be inferred from segment
  count alone (`rest.length > 1`) -- that worked only while every route with an extra segment really
  was site-scoped, which broke once `groups/:id?/:section?` and `users/:id?/:section?` (Users pages,
  not site-scoped) started carrying just as many segments whenever their optional params were
  populated, e.g. `/_admin/groups/5/members` misread as site-scoped (OpenProject #3343). The fix reads
  `route.meta.siteScoped` -- set explicitly on each `:siteid/...` route in `router/routes.js` -- instead
  of parsing the path shape.
*/
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

/*
  Optional on purpose: this renders inside all 38 admin pages, and a page mounted on its own -- which
  is how most of them are unit-tested -- has no router around it to inject one. Absent a route there
  is no section to name, so the overline reads as the area alone rather than throwing the page down
  with it.
*/
const route = useRoute()
const { t } = useI18n()

/**
 * Every admin page name (the last route segment, with no `<siteId>`) to the sidebar group it renders
 * under in `AdminLayout.vue`. Kept in the same order as the sidebar so a diff against it is easy to
 * eyeball. `dashboard`/`sites` are handled separately below (they sit above the first section header,
 * not inside a group's page list), but are listed here too for completeness.
 */
const PAGE_GROUPS = new Map([
  // Overview
  ['dashboard', 'admin.nav.overview'],
  ['sites', 'admin.nav.overview'],
  // Content
  ['pages', 'admin.nav.content'],
  ['pages/deleted', 'admin.nav.content'],
  ['glossary', 'admin.nav.content'],
  ['comments', 'admin.nav.content'],
  ['approvals', 'admin.nav.content'],
  ['classification', 'admin.nav.content'],
  // Site
  ['general', 'admin.nav.siteConfiguration'],
  ['theme', 'admin.nav.siteConfiguration'],
  ['navigation', 'admin.nav.siteConfiguration'],
  ['locale', 'admin.nav.siteConfiguration'],
  ['login', 'admin.nav.siteConfiguration'],
  ['storage', 'admin.nav.siteConfiguration'],
  // Editing & Search
  ['editors', 'admin.nav.editingTools'],
  ['blocks', 'admin.nav.editingTools'],
  ['search', 'admin.nav.editingTools'],
  ['icons', 'admin.nav.editingTools'],
  // Access
  ['auth', 'admin.nav.usersAccess'],
  ['groups', 'admin.nav.usersAccess'],
  ['users', 'admin.nav.usersAccess'],
  ['audit', 'admin.nav.usersAccess'],
  ['security', 'admin.nav.usersAccess'],
  // Monitoring
  ['system', 'admin.nav.monitoringHealth'],
  ['metrics', 'admin.nav.monitoringHealth'],
  ['pageviews', 'admin.nav.monitoringHealth'],
  ['livelog', 'admin.nav.monitoringHealth'],
  ['cluster', 'admin.nav.monitoringHealth'],
  ['replication', 'admin.nav.monitoringHealth'],
  ['scheduler', 'admin.nav.monitoringHealth'],
  // Integrations
  ['api', 'admin.nav.integrationsAutomation'],
  ['webhooks', 'admin.nav.integrationsAutomation'],
  ['extensions', 'admin.nav.integrationsAutomation'],
  ['mail', 'admin.nav.integrationsAutomation'],
  ['analytics', 'admin.nav.integrationsAutomation'],
  // Advanced
  ['flags', 'admin.nav.securityAdvanced'],
  ['utilities', 'admin.nav.securityAdvanced']
])

const sectionKey = computed(() => {
  if (!route?.path) {
    return null
  }
  const segments = route.path.split('/').filter(Boolean)
  // -> ['_admin', …]; anything shorter is the bare `/_admin` redirect, which lands on the dashboard
  const rest = segments.slice(1)
  // A site-scoped page's path is `/_admin/<siteId>/<page...>` -- one extra segment ahead of the page
  // name itself. Whether to strip it is read from route.meta, never re-derived from segment count
  // (OpenProject #3343): `groups/:id?/:section?` and `users/:id?/:section?` can carry just as many
  // segments as a site-scoped route without being one.
  const page = route.meta?.siteScoped
    ? rest.slice(1).join('/') || 'dashboard'
    : (rest[0] ?? 'dashboard')
  return PAGE_GROUPS.get(page) ?? null
})

const label = computed(() =>
  sectionKey.value ? `${t('admin.eyebrow')} · ${t(sectionKey.value)}` : t('admin.eyebrow')
)
</script>
