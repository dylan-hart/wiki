<template>
  <component :is="level" class="w-card-header w-section-header">
    <div class="w-card-header__row">
      <div class="min-w-0 flex-1">
        <div :id="headingId" class="w-card-header__title">
          <slot />
        </div>
        <div v-if="$slots.hint" class="w-card-header__hint text-caption">
          <slot name="hint" />
        </div>
      </div>
      <div v-if="$slots.action" class="w-card-header__action shrink-0">
        <slot name="action" />
      </div>
    </div>
  </component>
</template>

<script setup>
/**
 * The band's visual lives in `.w-section-header` (css/tailwind.css), because the profile pages and
 * side panels draw the same band outside a card. Its metrics are that class's: a caller that pads
 * the box this sits in names its inset once as `--w-section-bleed` on that box, never a padding
 * utility or negative margin on this element.
 *
 * `headingId` is exposed so a wrapping `WDialog` can point `labelled-by` at the heading already on
 * screen instead of duplicating the title into an `aria-label`.
 *
 * `level` is purely semantic -- the classes are pure typography, so the tag changes nothing
 * visually. `h2` suits a caller sitting under the page's own `<h1>`; one nested deeper passes
 * `h3`/`h4` so the document does not skip or repeat a level.
 */
import { useId } from 'vue'

defineProps({
  level: {
    type: String,
    default: 'h2',
    validator: (val) => ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(val)
  }
})

/** Stable for the instance's lifetime: `useId()` never regenerates on re-render. */
const headingId = useId()

defineExpose({ headingId })
</script>

<style scoped>
/*
  Nothing here touches the band's padding or height -- those are `.w-section-header`'s. A header
  given a `#hint` is the one shape that outgrows the strip, the hint being a second line INSIDE the
  band by design rather than drift.
*/
.w-card-header__row {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  width: 100%;
}

/*
  Back to sentence-case body type, out of the band's tracked uppercase mono: the hint is a sentence,
  not a label, and unreadable at that tracking.
*/
.w-card-header__hint {
  margin-top: 2px;
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: normal;
  text-transform: none;
  color: var(--color-text-caption);
}

:global(body.body--dark .w-card-header__hint) {
  color: var(--color-text-caption-dark);
}

/*
  The action is a control, not heading text: without opting out of the band's colour and tracking, a
  flat button with no colour of its own comes out slate, uppercase and spaced.
*/
.w-card-header__action {
  color: initial;
  letter-spacing: normal;
  text-transform: none;
}

:global(body.body--dark .w-card-header__action) {
  color: var(--color-text-dark);
}
</style>
