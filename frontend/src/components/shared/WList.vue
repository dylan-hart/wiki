<template>
  <div class="w-list" :class="classes">
    <slot />
  </div>
</template>

<script setup>
import { computed } from 'vue'

/**
 * Vertical list container for `WItem` children. `separator` draws the dividing rules itself with a
 * child combinator, rather than needing a separator element between every pair of items.
 */
const props = defineProps({
  separator: {
    type: Boolean,
    default: false
  },
  padding: {
    type: Boolean,
    default: false
  },
  bordered: {
    type: Boolean,
    default: false
  },
  dense: {
    type: Boolean,
    default: false
  },
  /**
   * Renders for a dark surface regardless of the app theme, for a list on a panel that is dark in
   * both themes (the admin sidebar) and so cannot key its colours off `dark:`.
   */
  dark: {
    type: Boolean,
    default: false
  }
})

const classes = computed(() => [
  props.padding ? 'py-2' : '',
  props.bordered ? 'rounded border border-hairline dark:border-hairline-dark' : '',
  props.separator ? 'w-list--separator' : '',
  props.dense ? 'w-list--dense' : '',
  props.dark ? 'w-list--dark' : ''
])
</script>

<style scoped>
/*
  Foreground colour belongs to "renders for a dark surface" rather than to each call site: an item
  label has no colour of its own and inherits the document's, which in light mode is black on black
  here. The dimmed labels are restated for the same reason -- their `dark:` half keys off the app
  theme, not off the surface they sit on.
*/
.w-list--dark {
  color: #fff;
}

.w-list--dark :deep(.w-item-label--caption),
.w-list--dark :deep(.w-item-label--header),
/* And a `side` section, dimmed the same theme-keyed way. An avatar section keeps full contrast. */
.w-list--dark :deep(.w-item-section--side:not(.w-item-section--avatar)) {
  color: rgb(255 255 255 / 0.7);
}

/*
  A row's own hover tint is black, swapped for white by the `dark:` variant -- which keys off the
  app theme, so on a panel that is dark in light mode the black tint lands invisibly.
*/
@media (hover: hover) {
  .w-list--dark :deep(> .w-item--clickable:not(:has(:disabled)):hover) {
    background-color: rgb(255 255 255 / 0.14);
  }
}

.w-list--dark :deep(> .w-item--clickable:not(:has(:disabled)):active) {
  background-color: rgb(255 255 255 / 0.22);
}

/* Same metrics as `WItem`'s own `dense`, so a list can set it once instead of row by row. */
.w-list--dense :deep(> .w-item) {
  min-height: 32px;
  padding-top: 2px;
  padding-bottom: 2px;
}

/*
  `:deep` because the items come from the consumer's slot and carry that component's scope
  attribute, not this one's. Drawn as a scaled pseudo-element rather than `border-top: 1px`, as
  `.w-hairline` is: a 1px border lands on fractional device rows under display scaling and comes out
  inconsistently thick, where this stays exactly one device pixel.
*/
.w-list--separator :deep(> * + *) {
  position: relative;
}

.w-list--separator :deep(> * + *)::before {
  content: '';
  position: absolute;
  top: 0;
  inset-inline-start: 0;
  inset-inline-end: 0;
  height: 1px;
  background-color: rgb(0 0 0 / 0.12);
  transform: scaleY(calc(1 / var(--w-dpr, 1)));
  transform-origin: top left;
  pointer-events: none;
}

:global(body.body--dark .w-list--separator > * + *::before),
.w-list--separator.w-list--dark :deep(> * + *)::before {
  background-color: rgb(255 255 255 / 0.15);
}
</style>
