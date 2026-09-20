<template>
  <w-item-section v-if="!standalone" avatar>
    <div class="blueprint-icon" :class="{ 'blueprint-icon--compact': props.compact }">
      <w-badge v-if="indicatorDot" :color="indicatorDot" floating>
        <w-tooltip v-if="props.indicatorText">{{ props.indicatorText }}</w-tooltip>
      </w-badge>
      <w-icon v-if="!textMode" :name="icon" />
      <span v-else class="blueprint-icon__text">{{ props.text }}</span>
    </div>
  </w-item-section>
  <div v-else class="blueprint-icon" :class="{ 'blueprint-icon--compact': props.compact }">
    <w-badge v-if="indicatorDot" :color="indicatorDot" floating>
      <w-tooltip v-if="props.indicatorText">{{ props.indicatorText }}</w-tooltip>
    </w-badge>
    <w-icon v-if="!textMode" :name="icon" />
    <span v-else class="blueprint-icon__text">{{ props.text }}</span>
  </div>
</template>

<script setup>
import { computed } from 'vue'

/**
 * `icon` is an ordinary Iconify reference (`tabler:key`), not an asset name assembled here: a name
 * built by concatenation is invisible to `scripts/generate-icons.mjs`'s scanner, so it would resolve
 * at runtime through `/_icons` instead of being inlined at build time.
 */
const props = defineProps({
  icon: {
    type: String,
    default: ''
  },
  indicator: {
    type: String,
    default: null
  },
  indicatorText: {
    type: String,
    default: null
  },
  /** Two or three letters drawn in place of the glyph. */
  text: {
    type: String,
    default: null
  },
  /**
   * Renders the plate alone, without the `WItemSection` wrapper. That wrapper is a `WItem`-ism: it
   * gives a list row's leading column its 56px width and 16px trailing gutter, right inside a
   * `WItem` and wrong anywhere the plate is one flex child laying out its own gap (`WSettingsRow`).
   * Pass this rather than overriding `.w-item-section--avatar` from outside.
   *
   * The two template branches are written out in full rather than as one body under a conditional
   * wrapper, because each has to be a SINGLE root: callers pass `class` through attribute
   * fallthrough, and Vue drops a fallthrough attribute on a fragment root with nothing but a dev
   * warning. That also rules out a template-level comment here -- `@vitejs/plugin-vue` PRESERVES
   * template comments in dev (it strips them for `vite build`), so one would make this a fragment
   * in dev only, which is the environment a developer actually looks at.
   */
  standalone: {
    type: Boolean,
    default: false
  },
  /**
   * The smaller of the two plates the design draws, for a menu opened at the pointer
   * (`PageNewMenu.vue`, in `contextMenu` mode). A boolean rather than a free-form `size`, because
   * the design names exactly two plates and nothing should introduce a third by passing a number.
   * Off by default, so every settings row -- most of this component's call sites -- keeps the
   * larger one.
   */
  compact: {
    type: Boolean,
    default: false
  }
})

const textMode = computed(() => props.text !== null)

const indicatorDot = computed(() => {
  if (props.indicator === null) {
    return null
  }
  return props.indicator === '' ? 'accent' : props.indicator
})
</script>

<style scoped>
/*
  The glyph is half the plate, which is what leaves the plate reading as a frame rather than as a
  border drawn tight around an icon.
*/
.blueprint-icon {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--color-hairline);
  background-color: var(--color-paper);
  color: var(--color-slate);
  font-size: 17px;
}

/*
  The pointer-anchored variant: the same ratio held a little tighter, as the design draws it, rather
  than a proportional scale of the base plate.
*/
.blueprint-icon--compact {
  width: 28px;
  height: 28px;
  font-size: 15px;
}

:global(body.body--dark .blueprint-icon) {
  border-color: var(--color-hairline-dark);
  background-color: var(--color-dark-4);
  color: var(--color-slate-light);
}

/*
  Cobalt draws the plate as a rounded, backgroundless outline in the saturated accent rather than
  Ledger's hairline-on-paper frame. `--color-accent-strong` is already redefined per Cobalt mode, so
  one rule covers both -- and declared after the dark rule, it wins the specificity tie for
  `body--cobalt.body--dark`.
*/
:global(body.body--cobalt .blueprint-icon) {
  border-radius: var(--radius-mark);
  background-color: transparent;
  border-color: var(--color-accent-strong);
  color: var(--color-accent-strong);
}

.blueprint-icon__text {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
</style>
