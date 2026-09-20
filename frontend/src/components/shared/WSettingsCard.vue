<template>
  <w-card class="w-settings-card">
    <component :is="level" :id="headingId" class="w-settings-card__header">
      <div class="w-settings-card__row">
        <div class="min-w-0 flex-1">
          <div class="w-settings-card__title">
            <slot name="title">{{ title }}</slot>
          </div>
          <div v-if="$slots.hint" class="w-settings-card__hint">
            <slot name="hint" />
          </div>
        </div>
        <div v-if="$slots.action" class="w-settings-card__action shrink-0">
          <slot name="action" />
        </div>
      </div>
    </component>
    <slot />
  </w-card>
</template>

<script setup>
/**
 * Deliberately NOT `<w-card-header>`: that renders `.w-section-header`, whose band genuinely differs
 * -- its own tint and type metrics, plus a trailing margin this design does not draw, since a
 * settings row butts straight up against the strip above it. Overriding all of that from a call site
 * is the drift that left `.w-section-header` re-stated in every caller, and would move other screens.
 *
 * `headingId` is exposed so a dialog wrapping this card can name itself off the heading already on
 * screen instead of repeating it as an `aria-label`.
 */
import { useId } from 'vue'

defineProps({
  /** Use the `title` slot instead when the strip's text is more than a string. */
  title: {
    type: String,
    default: ''
  },
  /**
   * `h2` by default: a settings card sits one level under the page's own `<h1>`. A card nested deeper
   * passes `h3`/`h4` so headings still nest.
   */
  level: {
    type: String,
    default: 'h2',
    validator: (val) => ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(val)
  }
})

const headingId = useId()

defineExpose({ headingId })
</script>

<style scoped>
/*
  No padding of its own: the rows run edge to edge, and the strip is ruled off from the first of them
  rather than floating above it.
*/
.w-settings-card {
  display: block;
}

.w-settings-card__row {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  width: 100%;
}

/*
  A sentence, not a label: uppercased at the strip's 0.18em tracking it is unreadable, so it drops
  back to sentence-case body type.
*/
.w-settings-card__hint {
  margin-top: 2px;
  color: var(--color-text-caption);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: normal;
  line-height: 1.45;
  text-transform: none;
}

:global(body.body--dark .w-settings-card__hint) {
  color: var(--color-text-caption-dark);
}

/*
  A control, not heading text: a flat button with no colour of its own would otherwise come out slate,
  uppercase and letter-spaced along with the title.
*/
.w-settings-card__action {
  color: initial;
  letter-spacing: normal;
  text-transform: none;
}

:global(body.body--dark .w-settings-card__action) {
  color: var(--color-text-dark);
}

.w-settings-card__header {
  margin: 0;
  padding: 10px 14px;
  background-color: var(--color-tint-alt);
  border-bottom: 1px solid var(--color-hairline);
  color: var(--color-slate);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.18em;
  line-height: 1.2;
  text-transform: uppercase;
}

:global(body.body--dark .w-settings-card__header) {
  background-color: var(--color-dark-2);
  border-bottom-color: var(--color-hairline-dark);
  color: var(--color-slate-light);
}
</style>
