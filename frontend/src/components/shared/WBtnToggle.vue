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
 * A run of hairline boxes sharing their edges, the selected one filled. There is no relief
 * treatment and so no `push`/`glossy`/`noCaps` variant props.
 *
 * The four colour props all exist because the admin toolbars flip each of them on the theme rather
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
   * Fill of the selected segment. The default token is not `primary`: an accent fill carrying white
   * text resolves per theme, so each theme names its own selected-segment tone.
   */
  toggleColor: {
    type: String,
    default: 'segment-selected'
  },
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
      /*
        Glow only under the DEFAULT fill: a caller naming its own `toggle-color` is not drawing the
        page's primary action, and an accent-tinted glow under its fill reads as a stray artefact.
      */
      boxShadow: props.toggleColor === 'segment-selected' ? 'var(--shadow-primary)' : undefined,
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
  Height as `min-height` rather than a padding pair: the 30px band has to hold whether a segment
  carries a label, an icon, or both, and only `min-height` does not change with its contents.
*/
.w-btn-toggle__segment {
  min-height: 30px;
}

/*
  An unselected segment is a control, not secondary text, so it states its own tone rather than
  inheriting -- an item's `side` section dims its contents, which left these labels a washed-out
  grey. A `text-color` prop still wins, arriving as an inline style.
*/
.w-btn-toggle__segment[aria-checked='false'] {
  color: var(--color-slate);
}

:global(body.body--dark .w-btn-toggle__segment[aria-checked='false']) {
  color: var(--color-text-dark);
}

/*
  Cobalt dark draws an unselected label in the chrome tone, not the generic dark-mode body text the
  rule above uses; the extra `.body--cobalt` outranks it by specificity, leaving Ledger dark alone.
*/
:global(body.body--cobalt.body--dark .w-btn-toggle__segment[aria-checked='false']) {
  color: var(--color-dark-3-5-text);
}
</style>
