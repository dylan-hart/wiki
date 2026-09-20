import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useUserStore } from '@/stores/user'

/**
 * The group-wide permissions that, alongside the matching `site:*` one, reach a site-scoped admin
 * surface. Each entry mirrors that surface's own backend route rather than a blanket `manage:sites`
 * — `site:navigation` deliberately accepts only `manage:navigation`, which is all
 * `backend/api/navigation.ts` checks, and `site:theme` also takes the instance-wide `manage:theme`.
 * Too narrow hides a page the backend would let someone into; too broad shows a save that then 403s.
 */
const GLOBAL_FALLBACKS = {
  'site:general': ['manage:sites'],
  'site:theme': ['manage:sites', 'manage:theme'],
  'site:login': ['manage:sites'],
  'site:locale': ['manage:sites'],
  'site:editors': ['manage:sites'],
  'site:blocks': ['manage:sites'],
  'site:navigation': ['manage:navigation'],
  'site:approvals': ['manage:sites']
}

/**
 * A plain function rather than a composable, taking `siteId` explicitly, so `AdminLayout.vue`'s
 * sidebar can ask once per nav item without a `useRoute()` of its own. `canOnSite` fails closed
 * while `sitePermissions` has not been fetched for this site, or was fetched for a different one.
 */
export function maySeeSiteSurface(userStore, permission, siteId) {
  if (GLOBAL_FALLBACKS[permission]?.some((p) => userStore.can(p))) {
    return true
  }
  return userStore.canOnSite(permission, siteId)
}

/**
 * `access:admin`, which `AdminLayout.vue` checks on every `/_admin/*` route, says nothing about
 * WHICH site or WHICH surface of it. The server-side `checkSiteAccess()` is the actual boundary;
 * this is the courtesy half that turns a 403-on-save into a redirect, so it is allowed to be
 * best-effort rather than something the render blocks on.
 *
 * Watches the route's `siteid` PARAM, not `adminStore.currentSiteId`: the param is what is true of
 * the page on screen, including a link followed straight to another site's admin page without the
 * picker ever being touched.
 *
 * `allowed` reads false between the param changing and the fetch it triggers resolving, because
 * `canOnSite` fails closed mid-fetch. Nothing acts on it until after that fetch, so the transient
 * false never causes a spurious redirect.
 *
 * @param permission One of `SITE_PERMISSIONS` — see `backend/helpers/siteRules.ts`.
 */
export function useSiteAdminAccess(permission) {
  const route = useRoute()
  const router = useRouter()
  const userStore = useUserStore()

  const siteId = computed(() => route.params.siteid)
  const allowed = computed(() => maySeeSiteSurface(userStore, permission, siteId.value))

  watch(
    siteId,
    async (newSiteId) => {
      if (GLOBAL_FALLBACKS[permission]?.some((p) => userStore.can(p))) {
        return
      }
      await userStore.fetchSitePermissions(newSiteId)
      if (!allowed.value) {
        router.replace('/_error/unauthorized')
      }
    },
    { immediate: true }
  )

  return { allowed }
}
