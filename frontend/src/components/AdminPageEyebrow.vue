<template>
  <div class="admin-page-eyebrow">{{ label }}</div>
</template>

<script setup>
/*
  The overline above an admin page's title -- `ADMIN · SITE`, `ADMIN · SYSTEM` -- which is what the
  design puts there (`ui-redesign/Cardinal Wiki - Admin 3x.dc.html`): the area, then the section of it
  the reader is standing in, in the accent, above a title that names only the page.

  Derived from the route rather than declared page by page, so the 37 admin pages cannot disagree with
  the sidebar about which group they belong to. The four groups are exactly the sidebar's own
  (`AdminLayout.vue`): the two entries above the first section header are the overview, a site-scoped
  page carries `meta.siteScoped: true` (set on each `:siteid/...` route in `router/routes.js`), and
  the rest split by name.

  `meta.siteScoped` -- not the shape of the path -- is deliberate: `groups/:id?/:section?` and
  `users/:id?/:section?` (Users pages, not site-scoped) can carry just as many path segments as a
  site-scoped route once their optional params are populated (e.g. `/_admin/groups/5/members`), so
  counting segments after `/_admin` misclassified them (OpenProject #3343).
*/
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

/*
  Optional on purpose: this renders inside all 37 admin pages, and a page mounted on its own -- which
  is how most of them are unit-tested -- has no router around it to inject one. Absent a route there
  is no section to name, so the overline reads as the area alone rather than throwing the page down
  with it.
*/
const route = useRoute()
const { t } = useI18n()

/** The pages the sidebar groups under Users; everything left over is System. */
const USERS_PAGES = new Set(['auth', 'groups', 'users'])

const sectionKey = computed(() => {
  if (!route?.path) {
    return null
  }
  if (route.meta?.siteScoped) {
    return 'admin.nav.site'
  }
  const segments = route.path.split('/').filter(Boolean)
  // -> ['_admin', …]; anything shorter is the bare `/_admin` redirect, which lands on the dashboard
  const page = segments[1] ?? 'dashboard'
  if (page === 'dashboard' || page === 'sites') {
    return 'admin.nav.overview'
  }
  return USERS_PAGES.has(page) ? 'admin.nav.users' : 'admin.nav.system'
})

const label = computed(() =>
  sectionKey.value ? `${t('admin.eyebrow')} · ${t(sectionKey.value)}` : t('admin.eyebrow')
)
</script>
