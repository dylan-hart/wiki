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
  page is addressed as `/_admin/<siteId>/<page>` and is therefore the only shape with a segment
  between the prefix and the page name, and the rest split by name.
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
  const segments = route.path.split('/').filter(Boolean)
  // -> ['_admin', …]; anything shorter is the bare `/_admin` redirect, which lands on the dashboard
  const rest = segments.slice(1)
  if (rest.length > 1) {
    return 'admin.nav.site'
  }
  const page = rest[0] ?? 'dashboard'
  if (page === 'dashboard' || page === 'sites') {
    return 'admin.nav.overview'
  }
  return USERS_PAGES.has(page) ? 'admin.nav.users' : 'admin.nav.system'
})

const label = computed(() =>
  sectionKey.value ? `${t('admin.eyebrow')} · ${t(sectionKey.value)}` : t('admin.eyebrow')
)
</script>
