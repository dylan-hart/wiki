<template>
  <div
    class="w-btn-toggle inline-flex flex-nowrap align-middle"
    :class="isDisabled ? 'pointer-events-none opacity-60' : ''"
    role="radiogroup"
    :aria-label="ariaLabel">
    <button
      v-for="(opt, idx) of options"
      :key="idx"
      type="button"
      role="radio"
      :aria-checked="String(opt.value === modelValue)"
      class="w-btn-toggle__segment w-unstyled relative flex cursor-pointer items-center border px-3 text-[12px] leading-none transition-[background-color,border-color,color]"
      :class="[
        // -> Every segment carries a border, selected included, so selection never shifts the row
        idx > 0 ? 'border-s-0' : '',
        // -> Only the OUTER edges round -- `--radius-control` (0 under Ledger, a real value under
        //    Cobalt, OpenProject #2767/#2772) -- never each segment; the logical `-s-`/`-e-`
        //    corners keep this correct under RTL
        idx === 0 ? 'rounded-s-control' : '',
        idx === options.length - 1 ? 'rounded-e-control' : '',
        opt.value === modelValue
          ? 'font-medium'
          : 'border-hairline font-normal dark:border-border-dark',
        opt.value === modelValue && !toggleTextColor ? 'text-white' : '',
        opt.value !== modelValue ? 'hover:bg-tint dark:hover:bg-dark-2' : ''
      ]"
      :style="segmentStyle(opt)"
      @click="$emit('update:modelValue', opt.value)">
      <w-icon v-if="opt.icon" :name="opt.icon" class="me-1 align-middle" />
      <span v-if="opt.label !== undefined">{{ opt.label }}</span>
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'

/**
 * Segmented single-choice control.
 *
 * `options` is `[{ label, value, icon? }]`, the same shape the templates already build.
 *
 * Cardinal draws it as a run of hairline boxes sharing their edges, with the selected one filled in
 * the accent and the rest left as outline. Only the strip's own outer corners round (never each
 * segment), off `--radius-control` -- square under Ledger, a real radius under Cobalt (OpenProject
 * #2767/#2772). The engraved treatment this replaces -- a
 * bevelled seam between segments, a letterpress text shadow, an optional raised ledge and gloss --
 * is gone with the rest of the app's relief, and the `push`/`glossy`/`noCaps` props that selected
 * those variants went with it.
 *
 * Every segment carries a border, the selected one included (in its own fill colour, where it
 * disappears), rather than only the unselected ones. Otherwise selecting a segment would take a
 * pixel off its width and shuffle the whole row sideways.
 *
 * The four colour props are kept, because the admin toolbars flip all of them on the theme rather
 * than relying on a `dark:` variant.
 */
const props = defineProps({
  modelValue: {
    type: null,
    default: null
  },
  /** `[{ label, value, icon? }]` */
  options: {
    type: Array,
    default: () => []
  },
  /**
   * Colour of the selected segment.
   *
   * Defaults to `segment-selected` rather than `primary`: the handoff's fill/text split puts every
   * accent fill CARRYING WHITE TEXT on the accent tone, and a selected segment is named in that list
   * explicitly. Ledger's `--color-segment-selected` is `var(--color-primary)`, exactly what this
   * used to be, so nothing moves there; Cobalt's is `var(--color-accent)` (`#c8303c`), which is what
   * `Aesthetic Setting 3x`'s own Cobalt card draws.
   */
  toggleColor: {
    type: String,
    default: 'segment-selected'
  },
  /** Text colour of the selected segment. Defaults to white. */
  toggleTextColor: {
    type: String,
    default: null
  },
  /** Background of the unselected segments. Transparent when omitted. */
  color: {
    type: String,
    default: null
  },
  /** Text colour of the unselected segments. */
  textColor: {
    type: String,
    default: null
  },
  disabled: {
    type: Boolean,
    default: false
  },
  ariaLabel: {
    type: String,
    default: null
  }
})

defineEmits(['update:modelValue'])

const isDisabled = computed(() => props.disabled)

function segmentStyle(opt) {
  if (opt.value === props.modelValue) {
    return {
      backgroundColor: `var(--color-${props.toggleColor})`,
      // -> Matches the fill, so the border is invisible but still occupies its pixel
      borderColor: `var(--color-${props.toggleColor})`,
      color: props.toggleTextColor ? `var(--color-${props.toggleTextColor})` : undefined
    }
  }
  return {
    backgroundColor: props.color ? `var(--color-${props.color})` : undefined,
    color: props.textColor ? `var(--color-${props.textColor})` : undefined
  }
}
</script>

<style scoped>
/*
  An unselected segment is a control, not secondary text, so it takes Cardinal's chrome tone rather
  than inheriting whatever the context dims to -- an item's `side` section drops its contents to 54%
  black, which left these labels a washed-out grey. A `text-color` prop still wins, since that
  arrives as an inline style.

  Height is stated here rather than as a padding pair: the design's 30px band has to hold whether a
  segment carries a label, an icon, or both, and `min-height` on the segment is the one measurement
  that does not change with its contents.
*/
.w-btn-toggle__segment {
  min-height: 30px;
}

.w-btn-toggle__segment[aria-checked='false'] {
  color: var(--color-slate);
}

:global(body.body--dark .w-btn-toggle__segment[aria-checked='false']) {
  color: var(--color-text-dark);
}
</style>
