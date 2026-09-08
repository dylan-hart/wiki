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
 * (css/tailwind.css), because the profile pages and the side panels use the same band outside a
 * card -- a tinted strip in tracked uppercase Roboto Mono, ruled off underneath.
 *
 * The band's metrics -- 34px tall, `6px 16px`, 14px of gap trailing it -- are that class's and
 * nothing here or in a caller restates them. A caller that pads the box this sits in names its own
 * inset once as `--w-section-bleed` on that box; it does not give this element a padding utility or
 * a negative margin of its own, which is how eleven dialog headers came to be drawing the band at
 * `px-4 py-2` before the second pass unwound them.
 *
 * `.w-section-header`'s dark styling (`tailwind.css`) is two rules layered by specificity: the
 * generic `body.body--dark .w-section-header` resolves to `var(--color-dark-2)` /
 * `var(--color-slate-light)` (`#242b3a` / `#8ea6cf` under Ledger, correct there), and
 * `body.body--cobalt.body--dark .w-section-header` overrides both to `var(--color-dark-3-5)` /
 * `var(--color-dark-3-5-text)` (`#0e1540` / `#c9d6ff`), matching `Primitives Dark 3x -
 * Cobalt.dc.html`'s own "Section header & row" swatch -- a genuinely different value than the
 * confirm-dialog title band, which stays on `--color-dark-2` (see `WConfirmDialog.vue`'s own
 * comment; the two bands are deliberately different roles). `--color-dark-3-5` is its own new dark
 * ramp rung, not a repoint of `-2` or `-4` -- both of those back too many unrelated call sites to
 * safely redefine (OpenProject #2816, closing the gap #2773 logged).
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
  The band's own metrics come from `.w-section-header` (css/tailwind.css); what is left here is the
  row inside it and the two things a card header adds to a bare section header -- a hint line and a
  trailing control.

  It is a BAND now, not a heading with a wash behind it, so it starts at the card's top edge rather
  than needing an inset of its own -- the `padding-top: 16px` this replaces existed only because the
  old heading had no top edge to speak of.

  Nothing here touches the band's padding or height. A header given a `#hint` is the one shape that
  outgrows the 34px strip, because the hint is a second line INSIDE the band -- that is the slot's
  own design rather than drift, and its nine callers are all admin settings cards (`AdminStorage`,
  `AdminSearch`, `AdminIcons`, `AdminAuth`, `AdminLocale`), where the hint reads as part of the
  setting it heads.
*/
.w-card-header__row {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  width: 100%;
}

/*
  The hint drops out of the band's tracked uppercase mono and back into ordinary sentence-case body
  type: it is a sentence, not a label, and at 0.2em tracking it was unreadable.
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
  The action is a control, not heading text, so it opts out of the band's colour and tracking --
  otherwise a flat button with no colour of its own would come out slate, uppercase and spaced.
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
