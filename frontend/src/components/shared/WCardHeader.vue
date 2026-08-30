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
      <!--
        A trailing control (a reset button, say). It sits on the heading's own baseline rather than
        in a section below it, which is how these headings were already written.
      -->
      <div v-if="$slots.action" class="w-card-header__action shrink-0">
        <slot name="action" />
      </div>
    </div>
  </component>
</template>

<script setup>
/**
 * Heading band at the top of a `WCard`.
 *
 * Replaces the plain `WCardSection` + `text-subtitle1` pairing the admin cards used, so the whole
 * app draws a section heading the same way. The visual lives in `.w-section-header`
 * (css/tailwind.css), because the profile pages use the same treatment outside a card.
 *
 *   <w-card-header>
 *     Site info
 *     <template #hint>Shown in the browser tab</template>
 *     <template #action><w-btn ... /></template>
 *   </w-card-header>
 *
 * `headingId` is exposed so a `WDialog` wrapping this card can name itself off the heading it
 * already displays, rather than duplicating the title as a separate `aria-label`:
 *
 *   const header = useTemplateRef('header')
 *   <w-dialog :labelled-by="header?.headingId">
 *     <w-card-header ref="header">Site info</w-card-header>
 *   </w-dialog>
 *
 * `level` picks the element this root renders as -- `h2` by default, since most callers sit one
 * level under a page's own `<h1>` (`PageHeader.vue`'s title). A card nested deeper in the hierarchy
 * (a card-inside-a-dialog-inside-a-card) passes `h3`/`h4` so the document still nests headings
 * correctly instead of skipping or repeating a level. `.w-card-header`/`.w-section-header` are pure
 * typography (see `css/tailwind.css`), so swapping the tag changes nothing visually.
 */
import { useId } from 'vue'

defineProps({
  level: {
    type: String,
    default: 'h2',
    validator: (val) => ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(val)
  }
})

/** Stable for the component instance's lifetime -- `useId()` never regenerates on re-render. */
const headingId = useId()

defineExpose({ headingId })
</script>

<style scoped>
/*
  The heading's own padding has no top edge -- on a page it follows other content. At the top of a
  card it needs the card's own inset, matching the section it replaces.
*/
.w-card-header {
  padding-top: 16px;
}

.w-card-header__row {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
}

/*
  The hint is the same blue as the title, lightened towards white so it reads as subordinate
  without turning into a second colour. Mixing towards white in BOTH themes on purpose: mixing
  towards the surface would darken it against a dark card and make it harder to read, which is the
  opposite of what a lighter shade should do.
*/
.w-card-header__hint {
  margin-top: 2px;
  font-weight: 400;
  color: color-mix(in srgb, var(--color-primary) 80%, var(--color-white));
}

:global(body.body--dark .w-card-header__hint) {
  color: color-mix(in srgb, var(--color-primary) 55%, var(--color-white));
}

/*
  The action is a control, not heading text, so it opts out of the heading's colour -- otherwise a
  flat button with no colour of its own would come out primary-blue.
*/
.w-card-header__action {
  color: initial;
}

:global(body.body--dark .w-card-header__action) {
  color: #fff;
}
</style>
