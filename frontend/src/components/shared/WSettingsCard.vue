<template>
  <w-card class="w-settings-card">
    <component :is="level" :id="headingId" class="w-settings-card__header">
      <slot name="title">{{ title }}</slot>
    </component>
    <slot />
  </w-card>
</template>

<script setup>
/**
 * A settings card: a mono uppercase header strip over a stack of `WSettingsRow`s.
 *
 *   <w-settings-card :title="t('admin.general.siteInfo')">
 *     <w-settings-row icon="tabler:home" :label="..." :hint="...">
 *       <w-input v-model="..." dense />
 *     </w-settings-row>
 *   </w-settings-card>
 *
 * This pair is the pattern the ~35 remaining settings pages adopt, so that the treatment is
 * described once instead of hand-applied per page -- the same reasoning behind
 * `composables/adminSettings.js`, which 22 of those pages already share for their load/save
 * skeleton. `AdminGeneral.vue` is the reference call site.
 *
 * -- Why this is NOT `<w-card-header>` -----------------------------------------------------------
 *
 * `WCardHeader` renders `.w-section-header`, the band 21 callers across the app already use, and
 * the two treatments genuinely differ: Cardinal's settings-card strip is `--color-tint-alt`
 * (#f0f2f7) at 10px/14px in 11px mono tracked 0.18em with NO trailing margin, where the section
 * header is `--color-tint` (#eef1f7) at 6px/16px in 10px mono tracked 0.2em with a 12px
 * `margin-block-end` -- a gap the design does not draw, since a settings row butts straight up
 * against the strip above it.
 *
 * Overriding all five of those from here would be precisely the drift that left `.w-section-header`
 * with eleven call sites each re-stating its padding, and would silently move six other screens.
 * Whether the two bands should converge on one set of metrics is a real question, and it belongs to
 * the Task that owns `.w-section-header` (#2631) -- not to a call site.
 *
 * `headingId` is exposed for the same reason `WCardHeader` exposes one: a dialog wrapping this card
 * can name itself off the heading already on screen instead of repeating it as an `aria-label`.
 */
import { useId } from 'vue'

defineProps({
  /** The strip's text. Use the `title` slot instead when it is more than a string. */
  title: {
    type: String,
    default: ''
  },
  /**
   * The element the strip renders as. `h2` by default, since a settings card sits one level under
   * the page's own `<h1>`; a card nested deeper passes `h3`/`h4` so headings still nest.
   */
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
  No padding of its own: the rows run edge to edge, and the strip is ruled off from the first of
  them rather than floating above it.
*/
.w-settings-card {
  display: block;
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

:global(body.body--dark) .w-settings-card__header {
  background-color: var(--color-dark-2);
  border-bottom-color: var(--color-hairline-dark);
  color: var(--color-slate-light);
}
</style>
