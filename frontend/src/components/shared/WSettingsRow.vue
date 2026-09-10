<template>
  <component :is="tag" class="w-settings-row" :class="rowClasses">
    <blueprint-icon
      v-if="icon || text"
      standalone
      :icon="icon"
      :text="text"
      :indicator="indicator"
      :indicator-text="indicatorText" />
    <!--
      Stacked: the label/hint and the control share one line, and the preview spans the full width
      under BOTH of them rather than under the control alone -- which is why the two need a wrapper
      of their own here and are plain siblings of the plate otherwise.
    -->
    <div v-if="$slots.preview" class="w-settings-row__body">
      <div class="w-settings-row__head">
        <div class="w-settings-row__text">
          <div class="w-settings-row__label">
            <slot name="label">{{ label }}</slot>
          </div>
          <div v-if="hint || $slots.hint" class="w-settings-row__hint">
            <slot name="hint">{{ hint }}</slot>
          </div>
        </div>
        <div class="w-settings-row__control" :class="controlClass">
          <slot />
        </div>
      </div>
      <div class="w-settings-row__preview">
        <slot name="preview" />
      </div>
    </div>
    <template v-else>
      <div class="w-settings-row__text">
        <div class="w-settings-row__label">
          <slot name="label">{{ label }}</slot>
        </div>
        <div v-if="hint || $slots.hint" class="w-settings-row__hint">
          <slot name="hint">{{ hint }}</slot>
        </div>
      </div>
      <div class="w-settings-row__control" :class="controlClass">
        <slot />
      </div>
    </template>
  </component>
</template>

<script setup>
import { computed, useSlots } from 'vue'

import BlueprintIcon from '@/components/BlueprintIcon.vue'

/**
 * One row of a `WSettingsCard`: a 34px hairline plate, a label over its hint, and the control at the
 * trailing edge, with the rule that separates it from the row above.
 *
 *   <w-settings-row icon="tabler:home" :label="t('...')" :hint="t('...Hint')">
 *     <w-input v-model="state.config.title" dense :aria-label="t('...')" />
 *   </w-settings-row>
 *
 * What it replaces is the `WItem` + `BlueprintIcon` + two `WItemSection` + two `WItemLabel` +
 * `WSeparator` stack every settings row was written out as by hand -- eleven lines and six
 * components per row, with the rule as a sibling the author had to remember to omit after the last
 * one. `WItem` is a general list row and stays exactly as it is for lists; this is the settings
 * row specifically, and it is where the Cardinal metrics (34px plate, 14px gap, 12px/14px padding,
 * the `--color-tint` rule) are stated once.
 *
 * The rule is drawn as a `border-top` on every row that FOLLOWS another (`.w-settings-row +
 * .w-settings-row`) rather than as a `border-bottom` dropped on the last: the adjacent-sibling
 * combinator matches elements only, so a `v-if`-ed row leaving a comment node behind cannot strand
 * a rule at the foot of a card.
 *
 * No hover or press tint, unlike `WItem`: the design does not draw one on a settings row, whose
 * click target is the control at its trailing edge rather than the row itself. `tag="label"` is
 * still how a toggle row is made clickable along its whole length -- the browser forwards the click
 * to the control inside.
 */
const props = defineProps({
  /** An Iconify reference for the plate, e.g. `tabler:home`. Omit for a row with no plate. */
  icon: {
    type: String,
    default: ''
  },
  /** Two or three letters on the plate in place of a glyph, for a row named by a code. */
  text: {
    type: String,
    default: null
  },
  /** A dot on the plate; the empty string means the accent. See `BlueprintIcon`. */
  indicator: {
    type: String,
    default: null
  },
  /** Tooltip on that dot. */
  indicatorText: {
    type: String,
    default: null
  },
  /** The row's name. Use the `label` slot instead when it is more than a string. */
  label: {
    type: String,
    default: ''
  },
  /** The sentence under it. Use the `hint` slot instead when it is more than a string. */
  hint: {
    type: String,
    default: ''
  },
  /**
   * How the control at the trailing edge is sized:
   *
   * - `grow` (default) -- shares the row's width with the label, `flex: 1 1 200px`. A single-line
   *   input or a select, both of which read as a field and want the width.
   * - `auto` -- sizes to its own content and sits hard against the trailing edge. A toggle, a
   *   segmented control, a pair of buttons: each has a width of its own and stretching it would
   *   leave it floating in the middle of the space.
   * - `fixed` -- a 200px column. The two-handle range, whose rail, tick markers and end labels only
   *   line up against a known width.
   */
  controlWidth: {
    type: String,
    default: 'grow',
    validator: (val) => ['grow', 'auto', 'fixed'].includes(val)
  },
  /**
   * Top-aligns the plate and the control instead of centring them. Implied by a `preview` slot,
   * whose row is taller than one line by definition.
   */
  top: {
    type: Boolean,
    default: false
  },
  /**
   * The element this renders as. `label` makes the whole row toggle the control inside it, which is
   * what every switch row uses; anything else stays a plain `div`.
   */
  tag: {
    type: String,
    default: 'div'
  }
})

const slots = useSlots()

const rowClasses = computed(() => ({
  'w-settings-row--top': props.top || Boolean(slots.preview)
}))

const controlClass = computed(() => `w-settings-row__control--${props.controlWidth}`)
</script>

<style scoped>
/*
  12px/14px padding and a 14px gap, which is what puts the label 48px in from the card's edge --
  the plate's 34px plus the gap. `flex-wrap` is what a narrow card does with the control: it drops
  to its own line rather than crushing the label.
*/
.w-settings-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding: 12px 14px;
  margin: 0;
}

.w-settings-row--top {
  align-items: flex-start;
}

/* -> The rule BETWEEN rows. See the header comment for why it is a top border. */
.w-settings-row + .w-settings-row {
  border-top: 1px solid var(--color-tint);
}

:global(body.body--dark .w-settings-row + .w-settings-row) {
  border-top-color: var(--color-hairline-dark);
}

.w-settings-row__body {
  display: flex;
  flex: 1 1 200px;
  flex-direction: column;
  min-width: 180px;
}

.w-settings-row__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}

.w-settings-row__text {
  flex: 1 1 180px;
  min-width: 150px;
}

/*
  14px/500 is cobalt-typography.md §3's "Field label" role -- the exact swatch is this component's
  own "Setting label" one, and `.w-input`/`.w-select`'s own `<label>` (`WFieldFrame.vue`) draws the
  identical role for the same reason: there is no separate control-label swatch, only this one.

  `line-height` is tighter than the size ratio the label used to carry (1.2), not a nicety. The app
  sets `body { line-height: 1.5 }`, which an unset label would inherit as a much taller line box; with
  the hint's own line box under it the text column would become the tallest thing in the row, taller
  than the 34px plate -- the plate then stops setting the row's height, and any row whose hint wraps,
  or has none at all, is a different height from its neighbours, which is the whole rhythm gone. 1.15
  here and 1.35 on the hint below keep the two-line column at ~33px, under the plate's 34px with the
  same margin the previous 13.5px/12px pair held. Pinned in `WSettingsRow.layout.test.js`.
*/
.w-settings-row__label {
  color: var(--color-ink);
  font-size: 14px;
  font-weight: 500;
  letter-spacing: normal;
  line-height: 1.15;
}

:global(body.body--dark .w-settings-row__label) {
  color: var(--color-text-dark);
}

/* 12.5px/400 is cobalt-typography.md §3's "Setting row description" role. */
.w-settings-row__hint {
  color: var(--color-text-secondary);
  font-size: 12.5px;
  font-weight: 400;
  letter-spacing: normal;
  line-height: 1.35;
}

:global(body.body--dark .w-settings-row__hint) {
  color: var(--color-text-secondary-dark);
}

.w-settings-row__control--grow {
  flex: 1 1 200px;
  min-width: 160px;
}

/*
  `margin-inline-start: auto` rather than `justify-content` on the row: the row's other children
  size themselves, so pushing from the control is what keeps it at the trailing edge whether or not
  the label happens to fill the space -- and it survives the wrap, where a justification would not.
*/
.w-settings-row__control--auto {
  flex: none;
  margin-inline-start: auto;
}

.w-settings-row__control--fixed {
  flex: none;
  width: 200px;
}

/* -> Spans the whole body, under the label and the control alike. */
.w-settings-row__preview {
  width: 100%;
  margin-top: 12px;
}
</style>
