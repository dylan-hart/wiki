<template>
  <!--
    Hop-2 "related via" indicator (OpenProject #3106, Feature #3094). Draws nothing unless `hop` is
    the literal number 2 -- a hop-1 result (the direct-match majority of both keyword and semantic
    results) and a keyword-mode result (which carries no `hop` field at all) both fall through to the
    same "nothing" case, which IS the direct-match signal per the parent Feature's acceptance
    criteria: there is no second, explicit "direct match" badge for this to pair with.

    A visible text label, not an icon alone or a title-only tooltip: WCAG 1.4.1 forbids conveying
    this distinction by color alone, and a hover/focus-only tooltip is not perceivable on a touch
    device with no pointer to hover. `w-icon` renders `aria-hidden="true"` on every one of its
    branches, so this chip's accessible name to assistive tech is exactly its visible text already --
    nothing extra to wire up.
  -->
  <w-chip
    v-if="hop === 2"
    class="search-result-hop-badge"
    size="sm"
    icon="tabler:link"
    :title="t('search.relatedResultHint')">
    {{ t('search.relatedResult') }}
  </w-chip>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

/**
 * The small "related via" marker a semantic-mode result row draws beside its title when the row's
 * own `hop` field (Task #3102's `/pages/search` response schema) is `2` -- a page that matched only
 * through its similarity to another page's own direct match, not the query itself.
 *
 * Its own component, rather than markup inlined into `Search.vue`'s result row, specifically so this
 * Task's diff and Task #3105's toggle/re-query work (which also lands in `Search.vue`, per this
 * round's epic coordination note) touch as few of the same lines as possible.
 */
defineProps({
  /**
   * A result row's `hop` value: `1` for a direct match, `2` for a result surfaced only via a hop-1
   * neighbor's similarity. Anything else -- `null`/`undefined` included, what every keyword-mode
   * result and every hop-1 semantic result carries -- draws nothing.
   */
  hop: {
    type: Number,
    default: null
  }
})

const { t } = useI18n()
</script>

<style scoped>
/*
  Sits beside the title text on the same line rather than wrapping under it -- the badge is short and
  the row already reserves no extra vertical space for it, so treating it as a small inline neighbor
  of the title (an inline-flex `w-chip` after inline text) keeps the row's height exactly what it was
  before this indicator existed.
*/
.search-result-hop-badge {
  margin-inline-start: 0.5em;
  vertical-align: middle;
}
</style>
