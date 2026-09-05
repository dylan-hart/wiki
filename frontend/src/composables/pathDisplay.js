import { computed } from 'vue'

import { useSiteStore } from '@/stores/site'
import { humanizePathSegment } from '@/helpers/pathHumanize'

/**
 * The site's `pathDisplayCase` setting (#2577) speaks its own wire enum -- `'off' | 'lower' | 'upper'
 * | 'camel' | 'pascal' | 'title'` -- distinct from `humanizePathSegment`'s own case-style contract
 * (#2576, `PATH_CASE_STYLES`). The two differ (`camel`/`pascal`/`title` vs. `camelCase`/`pascalCase`/
 * `titleCase`) because each belongs to a different owner, so this is the one place that translates
 * between them. `'off'` has no entry -- see `isActive` below, which short-circuits before this map
 * is ever consulted.
 */
const CASE_STYLE_MAP = {
  lower: 'lower',
  upper: 'upper',
  camel: 'camelCase',
  pascal: 'pascalCase',
  title: 'titleCase'
}

/**
 * Wires the current site's path-display setting and acronym map (Feature #2574) into the pure
 * `humanizePathSegment` helper (#2576), for every render site that shows a path-derived label:
 * breadcrumbs (`stores/page.js`'s `breadcrumbs` getter), sidebar/tree nav (`NavSidebarItem.vue`,
 * covering the auto-nav mode too -- see its own `generated` gate), and a page's own heading
 * (`PageHeader.vue`) -- #2578.
 *
 * Both `siteStore.pathDisplayCase` and `siteStore.acronymMap` are read live on every `humanize()`
 * call rather than snapshotted once, so a caller that holds onto the returned `humanize` function
 * across a reactive update (the acronym map arriving after `fetchAcronymMap()` resolves) still gets
 * the current values -- there is nothing to re-subscribe to.
 */
export function usePathDisplay() {
  const siteStore = useSiteStore()

  /** Whether the site has the setting on at all -- `'off'` means every render site shows the raw,
   *  stored label unchanged, exactly as before this feature existed. */
  const isActive = computed(() => siteStore.pathDisplayCase !== 'off')

  /**
   * Humanize a single raw path segment (e.g. `"getting-started"`), or return it unchanged when the
   * setting is off. Never partially transforms a multi-segment path -- callers slice their own last
   * segment off first, since word-splitting only happens on `-` within one segment
   * (`humanizePathSegment`'s own contract).
   */
  function humanize(segment) {
    if (!isActive.value) {
      return segment
    }
    return humanizePathSegment(
      segment,
      CASE_STYLE_MAP[siteStore.pathDisplayCase],
      siteStore.acronymMap
    )
  }

  return { isActive, humanize }
}
