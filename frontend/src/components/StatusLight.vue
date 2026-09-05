<template>
  <div class="status-light" :class="cssClasses" />
</template>

<script setup>
import { computed } from 'vue'

// PROPS

const props = defineProps({
  pulse: {
    type: Boolean,
    default: false
  },
  color: {
    type: String,
    default: ''
  }
})

// COMPUTED

const cssClasses = computed(() => {
  return `${props.color} ${props.pulse && 'pulsate'}`
})
</script>

<style lang="scss">
/*
  A 5px bar, square. Cardinal draws a status as a flat block of colour against the hairline grid --
  the rounded, gradient-lit pill this replaces read as a jewel light, which is one more piece of
  relief in a language that has none.

  `background-color: currentColor` keeps the state on `color`, so a caller can still tint one from
  outside; the three named states below are the vocabulary the design fixes (healthy / needs setup /
  off), and they take the bright FILL tones, not the darker text ones -- nothing is drawn over them.
*/
.status-light {
  display: block;
  width: 5px;
  height: 100%;
  min-height: 5px;
  color: $slate-pale;
  background-color: currentColor;

  &.negative {
    color: $negative-fill;
  }
  &.positive {
    color: $positive-fill;
  }
  &.warning {
    color: $warning-fill;
  }

  &.pulsate {
    animation: status-light-pulsate 2s ease infinite;
  }
}

@keyframes status-light-pulsate {
  0% {
    box-shadow: 0 0 5px 0 currentColor;
  }
  50% {
    box-shadow: 0 0 5px 2px currentColor;
  }
  100% {
    box-shadow: 0 0 5px 0 currentColor;
  }
}
</style>
