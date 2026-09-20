import { computed } from 'vue'

import { useSiteStore } from '@/stores/site'
import { humanizePathSegment } from '@/helpers/pathHumanize'

/**
 * The site's `pathDisplayCase` wire enum and `humanizePathSegment`'s `PATH_CASE_STYLES` are separate
 * contracts with different owners (`camel` vs. `camelCase`), so this is the one place that
 * translates between them. `'off'` has no entry: `isActive` short-circuits before the map is read.
 */
const CASE_STYLE_MAP = {
  lower: 'lower',
  upper: 'upper',
  camel: 'camelCase',
  pascal: 'pascalCase',
  title: 'titleCase'
}

/**
 * `siteStore.pathDisplayCase` and `siteStore.acronymMap` are read on every `humanize()` call rather
 * than snapshotted once, so a caller holding onto the returned function across a reactive update
 * (the acronym map arriving after `fetchAcronymMap()` resolves) still sees the current values.
 */
export function usePathDisplay() {
  const siteStore = useSiteStore()

  const isActive = computed(() => siteStore.pathDisplayCase !== 'off')

  /**
   * One segment at a time: word-splitting only happens on `-` within a segment, so a caller slices
   * its own last segment off a multi-segment path first.
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
