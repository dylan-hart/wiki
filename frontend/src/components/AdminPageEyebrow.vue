<template>
  <div class="admin-page-eyebrow">{{ label }}</div>
</template>

<script setup>
/*
  Derived from the route rather than declared page by page, so no admin page can disagree with the
  sidebar about which group it belongs to. The groups are exactly the sidebar's own
  (`AdminLayout.vue`).
*/
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

/*
  Optional on purpose: an admin page mounted on its own -- which is how most of them are unit-tested
  -- has no router around it to inject a route. Absent one the overline reads as the area alone
  rather than throwing the page down with it.
*/
const route = useRoute()
const { t } = useI18n()

/** Page name to sidebar group, kept in the sidebar's own order so a diff against it is easy. */
const PAGE_GROUPS = new Map([
  ['dashboard', 'admin.nav.overview'],
  ['sites', 'admin.nav.overview'],
  ['pages', 'admin.nav.content'],
  ['pages/deleted', 'admin.nav.content'],
  ['glossary', 'admin.nav.content'],
  ['comments', 'admin.nav.content'],
  ['approvals', 'admin.nav.content'],
  ['classification', 'admin.nav.content'],
  ['general', 'admin.nav.siteConfiguration'],
  ['theme', 'admin.nav.siteConfiguration'],
  ['navigation', 'admin.nav.siteConfiguration'],
  ['locale', 'admin.nav.siteConfiguration'],
  ['login', 'admin.nav.siteConfiguration'],
  ['storage', 'admin.nav.siteConfiguration'],
  ['editors', 'admin.nav.editingTools'],
  ['blocks', 'admin.nav.editingTools'],
  ['search', 'admin.nav.editingTools'],
  ['icons', 'admin.nav.editingTools'],
  ['auth', 'admin.nav.usersAccess'],
  ['groups', 'admin.nav.usersAccess'],
  ['users', 'admin.nav.usersAccess'],
  ['audit', 'admin.nav.usersAccess'],
  ['security', 'admin.nav.usersAccess'],
  ['system', 'admin.nav.monitoringHealth'],
  ['metrics', 'admin.nav.monitoringHealth'],
  ['pageviews', 'admin.nav.monitoringHealth'],
  ['livelog', 'admin.nav.monitoringHealth'],
  ['cluster', 'admin.nav.monitoringHealth'],
  ['replication', 'admin.nav.monitoringHealth'],
  ['scheduler', 'admin.nav.monitoringHealth'],
  ['api', 'admin.nav.integrationsAutomation'],
  ['webhooks', 'admin.nav.integrationsAutomation'],
  ['extensions', 'admin.nav.integrationsAutomation'],
  ['mail', 'admin.nav.integrationsAutomation'],
  ['analytics', 'admin.nav.integrationsAutomation'],
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
  // name. Whether to strip it is read from route.meta, never re-derived from segment count:
  // `groups/:id?/:section?` and `users/:id?/:section?` can carry just as many segments without
  // being site-scoped.
  const page = route.meta?.siteScoped
    ? rest.slice(1).join('/') || 'dashboard'
    : (rest[0] ?? 'dashboard')
  return PAGE_GROUPS.get(page) ?? null
})

const label = computed(() =>
  sectionKey.value ? `${t('admin.eyebrow')} · ${t(sectionKey.value)}` : t('admin.eyebrow')
)
</script>
