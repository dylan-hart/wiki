<template>
  <!--
    Semantic-mode "match strength" indicator (OpenProject #3223). Draws nothing unless `distance` is
    an actual number -- a keyword-mode result carries no `distance` field at all
    (`SemanticSearchResult.distance` is a semantic-only wire field, `backend/api/schemas/search.ts`),
    so `null`/`undefined` both fall through to the same "nothing" case as `SearchResultHopBadge`'s own
    `hop` guard.

    Plain text, not a `w-chip` (OpenProject #3293) -- it renders inside `Search.vue`'s top-right meta
    column now, alongside the row's date, rather than crammed onto the title line, so it needs
    neither the chip's icon nor its bordered pill background to read as its own element. Still a
    visible text label rather than an icon+color alone: same WCAG 1.4.1 reasoning as
    `SearchResultHopBadge`.
  -->
  <span v-if="percent !== null" class="search-result-similarity-badge">
    {{ t('search.similarityMatch', { percent }) }}
  </span>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * The "N% match" badge a semantic-mode result row draws beside its title, derived from the row's
 * own `distance` field (Task #3102's `/pages/search/semantic` response schema) -- the raw cosine
 * distance the API returns, never shown as-is per this Task's resolved scope: smaller distance means
 * a closer match, which is the opposite direction a reader expects a percentage to read.
 *
 * Its own component, rather than markup inlined into `Search.vue`'s result row, for the same reason
 * `SearchResultHopBadge` is: keeping this Task's diff to as few shared lines as possible.
 */
const props = defineProps({
  /**
   * A result row's `distance` value: cosine distance between the query embedding and the row's
   * best-matching chunk, smaller = closer. `null`/`undefined` -- what every keyword-mode result
   * carries, having no `distance` field at all -- draws nothing.
   */
  distance: {
    type: Number,
    default: null
  }
})

const { t } = useI18n()

/**
 * `Math.round((1 - distance) * 100)`, per this Task's resolved scope note -- clamped to `[0, 100]`
 * rather than trusting cosine distance to stay within `[0, 1]` in practice, so an embedding model
 * that occasionally returns a distance outside that range still reads as a sane percentage instead
 * of a negative or triple-digit one.
 */
const percent = computed(() => {
  if (props.distance === null || props.distance === undefined || Number.isNaN(props.distance)) {
    return null
  }
  const raw = Math.round((1 - props.distance) * 100)
  return Math.min(100, Math.max(0, raw))
})
</script>
