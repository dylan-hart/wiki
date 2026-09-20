<template>
  <!--
    A visible text label, not an icon alone or a title-only tooltip: WCAG 1.4.1 forbids conveying
    this distinction by color alone, and a hover/focus-only tooltip is not perceivable on a touch
    device with no pointer to hover. `w-icon` renders `aria-hidden="true"` on every one of its
    branches, so this chip's accessible name is exactly its visible text.
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

defineProps({
  /**
   * A result row's `hop` value: `1` for a direct match, `2` for a page surfaced only through its
   * similarity to a hop-1 neighbor rather than the query itself. Anything else -- including the
   * absent field every keyword-mode result carries -- draws nothing.
   */
  hop: {
    type: Number,
    default: null
  }
})

const { t } = useI18n()
</script>

<style scoped>
/* -> An inline neighbor of the title rather than a block under it, so the row's height is unchanged */
.search-result-hop-badge {
  margin-inline-start: 0.5em;
  vertical-align: middle;
}
</style>
