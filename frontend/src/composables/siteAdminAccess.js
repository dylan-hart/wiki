import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useUserStore } from '@/stores/user'

/**
 * Which group-wide permissions, ALONGSIDE the matching `site:*` permission, let a caller reach a
 * site-scoped admin surface — one entry per `SITE_PERMISSIONS` string (see
 * `backend/helpers/siteRules.ts`), mirroring each surface's own backend route exactly rather than
 * a single blanket `manage:sites`:
 *
 *   - `site:general` / `site:login` / `site:locale` / `site:editors` / `site:blocks`: `manage:sites`
 *     alone already covers these (see `SITE_FIELD_PERMISSIONS` in `backend/api/sites.ts` and
 *     `mayManageBlocks` in `backend/api/blocks.ts`).
 *   - `site:theme`: `manage:sites` OR the older, instance-wide `manage:theme` (task #681) — see the
 *     PUT `/:siteId` handler's `maySaveThemeOnly` branch.
 *   - `site:navigation`: `manage:navigation` ONLY — deliberately not `manage:sites`. That mirrors
 *     `canManageNavigation` in `backend/api/navigation.ts`, which has never accepted `manage:sites`
 *     for this surface, before or after delegation existed.
 *   - `site:approvals`: `manage:sites` OR `read:sites` — see `mayReadApprovalRules` in
 *     `backend/api/approvals.ts`. (`read:sites` is presently ungrantable through the group editor —
 *     see CLAUDE.md's closed global-permission list — so in practice this behaves as `manage:sites`
 *     alone; listed anyway for exact backend parity.)
 *
 * Getting one of these combos wrong in either direction is a real bug: too narrow hides a page from
 * someone the backend would actually let in, too broad shows a page — or a save button — that then
 * 403s. Keep this in step with the route file it mirrors if that route's own check ever changes.
 */
const GLOBAL_FALLBACKS = {
  'site:general': ['manage:sites'],
  'site:theme': ['manage:sites', 'manage:theme'],
  'site:login': ['manage:sites'],
  'site:locale': ['manage:sites'],
  'site:editors': ['manage:sites'],
  'site:blocks': ['manage:sites'],
  'site:navigation': ['manage:navigation'],
  'site:approvals': ['manage:sites', 'read:sites']
}

/**
 * Whether the caller may reach a site-scoped admin surface on a given site — combining the group-wide
 * fallbacks above with `userStore.canOnSite`, which itself fails closed while `sitePermissions`
 * has not been fetched for this site (or was fetched for a different one).
 *
 * A plain function rather than a composable of its own: it takes `siteId` explicitly so
 * `AdminLayout.vue`'s sidebar can ask it once per nav item, for whichever site
 * `adminStore.currentSiteId` currently is, without a `useRoute()` of its own.
 */
export function maySeeSiteSurface(userStore, permission, siteId) {
  if (GLOBAL_FALLBACKS[permission]?.some((p) => userStore.can(p))) {
    return true
  }
  return userStore.canOnSite(permission, siteId)
}

/**
 * Gates one of the nine site-scoped `Admin*.vue` pages behind the `site:*` permission that governs
 * it, in addition to the coarse `access:admin` gate `AdminLayout.vue` already checks on every
 * `/_admin/*` route.
 *
 * `access:admin` says nothing about WHICH site, or WHICH surface of it — a delegated administrator
 * holding `site:theme` on site A only was, before this, one URL edit away from `/_admin/B/theme`, or
 * from any OTHER surface of site A entirely (`/_admin/A/login`, `/_admin/A/locale`, ...). This is the
 * client-side half of closing that: the same question `checkSiteAccess()` answers server-side (see
 * `backend/helpers/siteRules.ts`), asked before the page finishes rendering rather than only failing
 * the eventual save. The server-side check (task #683) is the actual security boundary; this is a
 * courtesy that turns a 403-on-save into a redirect, which is why it is allowed to be best-effort
 * around the unavoidable async gap described below, rather than something the render itself blocks on.
 *
 * Watches the route's `siteid` PARAM, not `adminStore.currentSiteId`: the two usually agree, but the
 * param is what is actually true of the page on screen, including the moment a reader follows a link
 * straight to a different site's admin page without the picker ever being touched — precisely the
 * scenario this exists to refuse.
 *
 * There is an unavoidable gap between the param changing and the fetch it triggers resolving, during
 * which `allowed` reads false even for someone who does hold the permission (`canOnSite` fails closed
 * mid-fetch — see `userStore.fetchSitePermissions`). That is the safe direction to be transiently
 * wrong in: nothing here acts on `allowed` until AFTER the fetch resolves, so it never causes a
 * spurious redirect — it only means a global-permission holder for whom `GLOBAL_FALLBACKS` already
 * says yes skips the fetch and never sees the gap at all, while someone relying purely on a `site:*`
 * grant has one in-flight network round trip before the page is confirmed reachable.
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
      // -> Already covered by a group-wide permission: no site-scoped fetch needed, and skipping it
      //    means an instance administrator navigating this area sees no extra network chatter at all.
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
