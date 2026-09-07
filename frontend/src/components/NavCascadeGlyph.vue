<template>
  <div class="nav-cascade-glyph" aria-hidden="true">
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke-width="1.2">
      <rect
        v-for="(bar, idx) in bars"
        :key="idx"
        :x="bar.x"
        :y="bar.y"
        :width="bar.width"
        height="3.5"
        :class="`nav-cascade-glyph__bar nav-cascade-glyph__bar--${bar.kind}`"
        :stroke-dasharray="bar.kind === 'dashed' ? '1.6 1.4' : null" />
    </svg>
  </div>
</template>

<script setup>
import { computed } from 'vue'

/**
 * The "Sidebar for this page" cascade-mode glyph (`NavEditMenu.vue`'s Ledger restyle,
 * ui-redesign-nav/HANDOFF.md §1): three stacked bars reading top-to-bottom as parent / this page /
 * descendants, coloured per the cascade `mode` the row they sit in represents. One small SVG
 * component per the handoff's own instruction, rather than an `icon` name -- the bar states
 * (filled/outlined/dashed, per bar) have no Iconify equivalent.
 *
 * It is reused unchanged across every mode row; only `mode` (and, at the root, `root`) change what
 * gets drawn. It is not the same glyph as the item editor overlay's own header icon (`NavEditOverlay
 * .vue`, Task #2801) -- that one is a different surface reusing the same three-bar "language" in
 * spirit, per the handoff, not this component.
 */
const props = defineProps({
  /** The cascade mode this row represents. */
  mode: {
    type: String,
    required: true,
    validator: (v) => ['inherit', 'override', 'overrideExact', 'hide', 'hideExact'].includes(v)
  },
  /**
   * Whether this row is one of the root page's own two modes (Show / Hide) -- those affect the
   * whole glyph, since there is no ancestor to draw a distinct "parent" bar for.
   */
  root: {
    type: Boolean,
    default: false
  }
})

// -> The three bars, top to bottom: parent, this page, descendants -- fixed geometry, independent
//    of mode. Matches the handoff's own coordinates (viewBox 20x20, height 3.5, stroke-width 1.2).
const BAR_LAYOUT = [
  { x: 1.5, y: 1.5, width: 17 },
  { x: 5.5, y: 8.25, width: 13 },
  { x: 9.5, y: 15, width: 9 }
]

/*
  Per bar, one of:
    'accent' -- filled accent, an affected row
    'slate'  -- filled slate, inherit's own PARENT bar only (the thing being inherited FROM)
    'dashed' -- outlined, dashed: a hidden row
    'plain'  -- outlined, solid: untouched by this mode

  See the handoff's own table (ui-redesign-nav/HANDOFF.md §1) for the mode -> bar-state mapping this
  encodes.
*/
const MODE_BARS = {
  inherit: ['slate', 'plain', 'plain'],
  override: ['plain', 'accent', 'accent'],
  overrideExact: ['plain', 'accent', 'plain'],
  hide: ['plain', 'dashed', 'dashed'],
  hideExact: ['plain', 'dashed', 'plain']
}

// -> At the root there is no parent to draw separately: Show/Hide act on the whole glyph.
const ROOT_MODE_BARS = {
  inherit: ['accent', 'accent', 'accent'],
  hide: ['dashed', 'dashed', 'dashed']
}

const bars = computed(() => {
  const kinds = (props.root ? ROOT_MODE_BARS : MODE_BARS)[props.mode] ?? ['plain', 'plain', 'plain']
  return BAR_LAYOUT.map((layout, idx) => ({ ...layout, kind: kinds[idx] }))
})
</script>

<style scoped>
/* The 28px hairline plate the glyph sits on -- matches `BlueprintIcon`'s own 34/28px plates. */
.nav-cascade-glyph {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--color-hairline);
  background-color: var(--color-surface);
}

:global(body.body--dark .nav-cascade-glyph) {
  border-color: var(--color-hairline-dark);
  background-color: var(--color-dark-4);
}

/*
  Cobalt (ui-redesign-nav/HANDOFF.md §1): 30px, radius 8px, no border -- the shadow (`--shadow-card`,
  #2767) substitutes for the hairline the same way every Cobalt card material drops its border for a
  shadow elsewhere in this file's sibling `.nav-edit-menu`.
*/
:global(body.body--cobalt .nav-cascade-glyph) {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}

.nav-cascade-glyph__bar--accent {
  fill: var(--color-accent-fill);
  stroke: var(--color-accent-fill);
}

.nav-cascade-glyph__bar--slate {
  fill: var(--color-slate-soft);
  stroke: var(--color-slate-soft);
}

.nav-cascade-glyph__bar--plain,
.nav-cascade-glyph__bar--dashed {
  fill: none;
  stroke: var(--color-slate-faint);
}

:global(body.body--dark .nav-cascade-glyph__bar--slate) {
  fill: var(--color-slate-light);
  stroke: var(--color-slate-light);
}

:global(body.body--dark .nav-cascade-glyph__bar--plain),
:global(body.body--dark .nav-cascade-glyph__bar--dashed) {
  stroke: var(--color-text-secondary-dark);
}

/*
  Cobalt's "inherit" row draws its parent bar in the cobalt identity blue rather than a desaturated
  slate (handoff: "inherit: parent bar filled slate (#64789f Ledger, #1f4fd6 Cobalt)") -- reusing
  `--color-accent-strong`, #2767's exact value for this role, rather than `--color-slate-soft` (which
  #2767 leaves at its Ledger value under Cobalt, since a slate tone is still correct everywhere else
  `--color-slate-soft` is used).
*/
:global(body.body--cobalt .nav-cascade-glyph__bar--slate) {
  fill: var(--color-accent-strong);
  stroke: var(--color-accent-strong);
}
</style>
