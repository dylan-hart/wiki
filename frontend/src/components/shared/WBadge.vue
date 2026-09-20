<template>
  <!--
    Mono, so two- and three-digit counts do not jump about in width as they change. The tracking and
    uppercase matter only for a text label, but are stated unconditionally because a badge draws
    every one of its roles the same way regardless of what is inside it.

    `min-h-3.5` is what makes a badge with no label a dot rather than a 14x4 sliver: the only child
    is often a tooltip, which renders nothing inline, so the box would otherwise be pure padding --
    14px wide from `px-1.5` but only 4px tall. 14px matches the width, so it comes out square. A
    badge that does carry a label is taller than this on its own and is unaffected.
  -->
  <div
    class="w-badge inline-flex min-h-3.5 items-center justify-center px-1.5 py-0.5 font-mono text-[9.5px] leading-none font-semibold tracking-[.16em] uppercase"
    :class="classes"
    :style="styles"
    :title="title">
    <slot>{{ label }}</slot>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  label: {
    type: [String, Number],
    default: null
  },
  color: {
    type: String,
    default: 'primary'
  },
  textColor: {
    type: String,
    default: null
  },
  outline: {
    type: Boolean,
    default: false
  },
  rounded: {
    type: Boolean,
    default: false
  },
  floating: {
    type: Boolean,
    default: false
  },
  title: {
    type: String,
    default: null
  }
})

const classes = computed(() => [
  // -> `--radius-mark` (0 under Ledger, a real value under Cobalt), never a hardcoded corner.
  props.rounded ? 'rounded-full' : 'rounded-mark',
  props.outline ? 'border border-current bg-transparent' : '',
  // -> The physical `right-0` is deliberate: the straddle is `translate-x-1/2`, a physical
  //    transform that never mirrors under RTL, so swapping only the position half to `end` would
  //    pull the badge the wrong way off its corner. TODO: correct the pair together -- a logical
  //    position plus a direction-aware straddle.
  props.floating ? 'absolute top-0 right-0 translate-x-1/2 -translate-y-1/3' : ''
])

const styles = computed(() =>
  props.outline
    ? { color: `var(--color-${props.color})` }
    : {
        backgroundColor: `var(--color-${props.color})`,
        color: `var(--color-${props.textColor ?? 'white'})`
      }
)
</script>
