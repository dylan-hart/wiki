<template>
  <div
    class="w-linear-progress relative w-full overflow-hidden"
    :class="rounded ? 'rounded-full' : ''"
    :style="{ height: resolvedSize }"
    role="progressbar"
    :aria-valuenow="indeterminate ? undefined : Math.round(value * 100)"
    :aria-valuemin="indeterminate ? undefined : 0"
    :aria-valuemax="indeterminate ? undefined : 100">
    <div class="absolute inset-0 opacity-25" :style="{ backgroundColor: trackColor }" />
    <!--
      -> `start-0`, not `left-0`: the anchored edge is the one progress reads as advancing FROM, a
         leading/trailing question rather than a screen-position one, so it must flip under RTL.
    -->
    <div
      class="absolute inset-y-0 start-0"
      :class="indeterminate ? 'w-linear-progress-indeterminate' : ''"
      :style="barStyle" />
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  /** Progress from 0 to 1. Ignored when `indeterminate` or `query` is set. */
  value: {
    type: Number,
    default: 0
  },
  indeterminate: {
    type: Boolean,
    default: false
  },
  /** Alias of `indeterminate`, kept for callers written against the previous component. */
  query: {
    type: Boolean,
    default: false
  },
  color: {
    type: String,
    default: 'primary'
  },
  /** A named size (`xs`..`xl`) or any CSS length. */
  size: {
    type: String,
    default: '4px'
  },
  rounded: {
    type: Boolean,
    default: false
  }
})

const NAMED_SIZES = { xs: '2px', sm: '4px', md: '6px', lg: '10px', xl: '14px' }

const resolvedSize = computed(() => NAMED_SIZES[props.size] ?? props.size)

/* The fallback is load-bearing: an unrecognised colour name otherwise renders an invisible bar. */
const trackColor = computed(() => `var(--color-${props.color}, var(--color-primary))`)

const isIndeterminate = computed(() => props.indeterminate || props.query)

const barStyle = computed(() => ({
  backgroundColor: trackColor.value,
  width: isIndeterminate.value ? undefined : `${Math.min(100, Math.max(0, props.value * 100))}%`,
  transition: isIndeterminate.value ? undefined : 'width 0.3s var(--ease-standard)'
}))
</script>

<style scoped>
.w-linear-progress-indeterminate {
  width: 50%;
  animation: w-linear-progress 1.4s ease-in-out infinite;
}

@keyframes w-linear-progress {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(200%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .w-linear-progress-indeterminate {
    animation-duration: 3s;
  }
}
</style>
