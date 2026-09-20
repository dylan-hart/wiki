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
      The preview spans the full width under BOTH the text and the control, which is why those two
      need a wrapper of their own here and are plain siblings of the plate otherwise.
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
 * The settings row specifically -- `WItem` stays the general list row -- and where the Cardinal
 * metrics (34px plate, 14px gap, 12px/14px padding, the `--color-tint` rule) are stated once.
 *
 * The rule is drawn as a `border-top` on every row that FOLLOWS another (`.w-settings-row +
 * .w-settings-row`) rather than as a `border-bottom` dropped on the last: the adjacent-sibling
 * combinator matches elements only, so a `v-if`-ed row leaving a comment node behind cannot strand
 * a rule at the foot of a card.
 *
 * No hover or press tint, unlike `WItem`: the click target is the control at the trailing edge, not
 * the row itself. `tag="label"` is what makes a toggle row clickable along its whole length instead.
 */
const props = defineProps({
  icon: {
    type: String,
    default: ''
  },
  /** Two or three letters on the plate in place of a glyph, for a row named by a code. */
  text: {
    type: String,
    default: null
  },
  /** A dot on the plate; the empty string means the accent. */
  indicator: {
    type: String,
    default: null
  },
  indicatorText: {
    type: String,
    default: null
  },
  /** Use the `label` slot instead when the row's name is more than a string. */
  label: {
    type: String,
    default: ''
  },
  /** Use the `hint` slot instead when the sentence under the label is more than a string. */
  hint: {
    type: String,
    default: ''
  },
  /**
   * How the control at the trailing edge is sized. `grow` shares the row's width with the label;
   * `auto` sizes to its own content and sits hard against the trailing edge, for a toggle or a button
   * pair that would otherwise float in the middle of the space; `fixed` is a 200px column, for the
   * range, whose rail, ticks and end labels only line up against a known width.
   */
  controlWidth: {
    type: String,
    default: 'grow',
    validator: (val) => ['grow', 'auto', 'fixed'].includes(val)
  },
  /** Top-aligns the plate and the control instead of centring them; implied by a `preview` slot. */
  top: {
    type: Boolean,
    default: false
  },
  /** `label` makes the whole row toggle the control inside it; anything else stays a plain `div`. */
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
  The 14px gap puts the label 48px in from the card's edge -- the plate's 34px plus the gap.
  `flex-wrap` is what a narrow card does with the control: it drops to its own line rather than
  crushing the label.
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
  14px/500 is cobalt-typography.md §3's "Field label" role, the same one `WFieldFrame.vue` draws for
  `.w-input`/`.w-select`: there is no separate control-label swatch, only this one.

  The tight `line-height` is not a nicety. `body { line-height: 1.5 }`, inherited, makes the two-line
  text column taller than the 34px plate; the plate then stops setting the row's height, and a row
  whose hint wraps -- or has none at all -- comes out a different height from its neighbours, which is
  the whole rhythm gone. 1.15 here and 1.35 on the hint below keep the column at ~33px. Pinned in
  `WSettingsRow.layout.test.js`.
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
  `margin-inline-start: auto` rather than `justify-content` on the row: pushing from the control keeps
  it at the trailing edge whether or not the label fills the space, and it survives the wrap, where a
  justification would not.
*/
.w-settings-row__control--auto {
  flex: none;
  margin-inline-start: auto;
}

.w-settings-row__control--fixed {
  flex: none;
  width: 200px;
}

.w-settings-row__preview {
  width: 100%;
  margin-top: 12px;
}
</style>
