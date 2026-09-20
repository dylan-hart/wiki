<template>
  <!--
    Plain text, not a `w-chip`: this renders inside `Search.vue`'s meta column alongside the row's
    date rather than on the title line, so it needs neither the chip's icon nor its pill background
    to read as its own element. Still a visible text label rather than an icon and color alone --
    same WCAG 1.4.1 reasoning as `SearchResultHopBadge`.
  -->
  <span v-if="percent !== null" class="search-result-similarity-badge">
    {{ t('search.similarityMatch', { percent }) }}
  </span>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  /**
   * Cosine distance between the query embedding and the row's best-matching chunk, smaller =
   * closer -- which is why it is shown inverted rather than as-is. `null`/`undefined`, what every
   * keyword-mode result carries, draws nothing.
   */
  distance: {
    type: Number,
    default: null
  }
})

const { t } = useI18n()

/**
 * Clamped rather than trusting cosine distance to stay within `[0, 1]`: an embedding model that
 * occasionally returns one outside that range would otherwise read as a negative or triple-digit
 * percentage.
 */
const percent = computed(() => {
  if (props.distance === null || props.distance === undefined || Number.isNaN(props.distance)) {
    return null
  }
  const raw = Math.round((1 - props.distance) * 100)
  return Math.min(100, Math.max(0, raw))
})
</script>
