<template>
  <span class="w-signal" :style="style" role="presentation">
    <span class="w-signal__ring" />
    <span class="w-signal__ring" />
    <span class="w-signal__core" />
  </span>
</template>

<script setup>
import { computed } from 'vue'
import { resolveSize } from './metrics'

/**
 * Distinct from `WSpinner` on purpose. A spinner says "working, please wait" and is expected to
 * stop; this says "live", and runs for as long as the thing it describes is in that state.
 *
 * Geometry mirrors the `q-spinner-rings` it replaces, so the two look identical at the same size.
 */
const props = defineProps({
  /** A named size, or any CSS length. */
  size: {
    type: String,
    default: '24px'
  },
  color: {
    type: String,
    default: null
  }
})

const style = computed(() => ({
  '--w-signal-size': resolveSize(props.size),
  color: props.color ? `var(--color-${props.color})` : undefined
}))
</script>

<style scoped>
.w-signal {
  display: inline-block;
  position: relative;
  flex-shrink: 0;
  width: var(--w-signal-size);
  height: var(--w-signal-size);
  vertical-align: middle;

  /* One unit of the original 45-unit viewBox, so the stroke scales with the component */
  --w-signal-unit: calc(var(--w-signal-size) / 45);
}

/*
  `border-box` is what keeps the correspondence with the SVG exact: an SVG circle's painted diameter
  is `2r + stroke`, which is precisely the border-box width of a bordered element.
*/
.w-signal__ring,
.w-signal__core {
  position: absolute;
  top: 50%;
  left: 50%;
  box-sizing: border-box;
  border: 0 solid currentColor;
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

/*
  Resting state, and what `prefers-reduced-motion` falls back to: a plain ring that still reads as a
  status light.
*/
.w-signal__ring {
  opacity: 0;
}

.w-signal__core {
  /* 2 * 6 + 2 units across */
  width: calc(var(--w-signal-unit) * 14);
  height: calc(var(--w-signal-unit) * 14);
  border-width: calc(var(--w-signal-unit) * 2);
}

.w-signal__ring {
  animation: w-signal-ring 3s linear infinite;
}

/* Half a cycle apart, so a new ring leaves as the previous one is midway out */
.w-signal__ring:nth-child(1) {
  animation-delay: 1.5s;
}
.w-signal__ring:nth-child(2) {
  animation-delay: 3s;
}

.w-signal__core {
  animation: w-signal-core 1.5s linear infinite;
}

/* Radius 6 -> 22 as the stroke thins 2 -> 0, so the ring dissolves as it reaches the edge */
@keyframes w-signal-ring {
  from {
    width: calc(var(--w-signal-unit) * 14);
    height: calc(var(--w-signal-unit) * 14);
    border-width: calc(var(--w-signal-unit) * 2);
    opacity: 1;
  }
  to {
    width: calc(var(--w-signal-unit) * 44);
    height: calc(var(--w-signal-unit) * 44);
    border-width: 0;
    opacity: 0;
  }
}

/* Collapses in one step and climbs back out in five -- a heartbeat, not a symmetrical throb */
@keyframes w-signal-core {
  0% {
    width: calc(var(--w-signal-unit) * 14);
    height: calc(var(--w-signal-unit) * 14);
  }
  16.667% {
    width: calc(var(--w-signal-unit) * 4);
    height: calc(var(--w-signal-unit) * 4);
  }
  33.333% {
    width: calc(var(--w-signal-unit) * 6);
    height: calc(var(--w-signal-unit) * 6);
  }
  50% {
    width: calc(var(--w-signal-unit) * 8);
    height: calc(var(--w-signal-unit) * 8);
  }
  66.667% {
    width: calc(var(--w-signal-unit) * 10);
    height: calc(var(--w-signal-unit) * 10);
  }
  83.333% {
    width: calc(var(--w-signal-unit) * 12);
    height: calc(var(--w-signal-unit) * 12);
  }
  100% {
    width: calc(var(--w-signal-unit) * 14);
    height: calc(var(--w-signal-unit) * 14);
  }
}

@media (prefers-reduced-motion: reduce) {
  .w-signal__ring,
  .w-signal__core {
    animation: none;
  }
}
</style>
