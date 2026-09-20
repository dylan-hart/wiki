<template>
  <component
    :is="tag"
    v-bind="linkAttrs"
    :type="isLink ? undefined : type"
    :disabled="isLink ? undefined : isDisabled || undefined"
    :aria-disabled="isLink && isDisabled ? 'true' : undefined"
    :aria-busy="loading || undefined"
    :title="title"
    :tabindex="tabindex"
    class="w-btn w-unstyled relative inline-flex flex-nowrap items-center justify-center gap-2 align-middle font-medium no-underline outline-offset-2 transition-[background-color,box-shadow,opacity,transform] select-none focus-visible:outline-2"
    :class="classes"
    :style="styles"
    @click="onClick">
    <!-- Overlays the content, which is held at full size but invisible, so the button does not
         resize mid-request -->
    <span v-if="loading" class="absolute inset-0 flex items-center justify-center">
      <w-spinner size="1.2em" />
    </span>
    <span
      class="relative inline-flex flex-nowrap items-center gap-2"
      :class="{ invisible: loading }">
      <w-icon v-if="icon" :name="icon" class="shrink-0" />
      <span v-if="label !== null">{{ label }}</span>
      <slot />
    </span>
  </component>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { contrastRatio } from '@/helpers/accessibility'
import WSpinner from './WSpinner.vue'

const props = defineProps({
  label: {
    type: [String, Number],
    default: null
  },
  icon: {
    type: String,
    default: null
  },
  /**
   * A color NAME (`primary`, `negative`, `grey-7`, ...), not a color value: it resolves against the
   * `--color-*` variables. Drives the background for solid variants, the text for flat ones.
   */
  color: {
    type: String,
    default: null
  },
  textColor: {
    type: String,
    default: null
  },
  flat: {
    type: Boolean,
    default: false
  },
  outline: {
    type: Boolean,
    default: false
  },
  round: {
    type: Boolean,
    default: false
  },
  rounded: {
    type: Boolean,
    default: false
  },
  /**
   * Named size (`xs`..`xl`) or any CSS length. Drives the button's font-size, which every other
   * metric is expressed in `em` against -- so one value scales padding, min-height and icon alike.
   */
  size: {
    type: String,
    default: null
  },
  dense: {
    type: Boolean,
    default: false
  },
  /** One or two size names or CSS lengths, vertical first (`xs md`, `sm`, `none`). */
  padding: {
    type: String,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  type: {
    type: String,
    default: 'button'
  },
  to: {
    type: [String, Object],
    default: null
  },
  href: {
    type: String,
    default: null
  },
  target: {
    type: String,
    default: null
  },
  title: {
    type: String,
    default: null
  },
  tabindex: {
    type: [String, Number],
    default: null
  }
})

const emit = defineEmits(['click'])

/** Quasar's button size scale, in px. */
const FONT_SIZES = { xs: 8, sm: 10, md: 14, lg: 20, xl: 24 }

/** Quasar's named spacing scale, for the `padding` prop. */
const SIZES = {
  none: '0',
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '48px'
}

const isDisabled = computed(() => props.disabled || props.loading)

const isLink = computed(() => Boolean(props.to || props.href))

const tag = computed(() => {
  if (props.to) {
    return 'router-link'
  }
  if (props.href) {
    return 'a'
  }
  return 'button'
})

const linkAttrs = computed(() => {
  if (props.to) {
    return { to: props.to }
  }
  if (props.href) {
    return {
      href: props.href,
      target: props.target,
      // -> Never let a new tab keep a handle on this window.
      rel: props.target === '_blank' ? 'noopener noreferrer' : undefined
    }
  }
  return {}
})

// -> Both flat and outline are unfilled; only the border distinguishes them.
const isSolid = computed(() => !props.flat && !props.outline)

/*
  `2.572em` (the resting min-height) is carried over from the metrics this replaces rather than
  recomputed: it lands on the design's 32px band at the default 12.5px and on a 36px band at 14px, so
  a caller that overrides `size` keeps a proportionate button either way.

  The corner is `--radius-control` except for `round` (a circle) and `rounded` (a pill), which are
  shapes a caller asks for outright rather than the aesthetic's corner style. `--radius-control` is
  `0` under Ledger and a real value under Cobalt -- one class, no aesthetic branch.

  No shadow and no gloss: a control is separated from its ground with a hairline, never with
  elevation, which is why there is no `unelevated`, `push`, `glossy` or `noCaps` prop -- a solid
  button IS unelevated, and a label IS cased as written. The one exception is `--shadow-primary`
  under `color="accent"`, the decided value for "this is the page's own primary action"; it is
  `none` under Ledger, so a no-op there.
*/
const classes = computed(() => [
  /*
    A stable hook for the variant, so a surrounding context can restyle its own unfilled buttons
    without having to re-derive which of the three variants they are from the utility soup.
  */
  isSolid.value ? 'w-btn--solid' : props.outline ? 'w-btn--outline' : 'w-btn--flat',
  props.size ? 'leading-[1.715em]' : 'text-[12.5px] leading-[1.715em]',
  props.round ? 'rounded-full' : props.rounded ? 'rounded-[28px]' : 'rounded-control',
  // -> The hairline, not `border-current`: an outlined button's edge is chrome, its label is not.
  props.outline ? 'border border-hairline dark:border-border-dark' : '',
  isDisabled.value ? 'pointer-events-none opacity-60' : 'cursor-pointer',
  // -> Flat buttons have no background of their own, so hover tints with the current text color.
  isSolid.value ? 'hover:brightness-110' : 'hover:bg-current/10'
])

/*
  Bumped by `applyTheme`, which rewrites the `--color-*` custom properties `foregroundColor` below
  resolves against without any prop of this button changing -- nothing would otherwise tell it to
  re-resolve.
*/
const themeGeneration = ref(0)
function onThemeApplied() {
  themeGeneration.value++
}
onMounted(() => EVENT_BUS.on('applyTheme', onThemeApplied))
onUnmounted(() => EVENT_BUS.off('applyTheme', onThemeApplied))

/*
  One hidden, reused probe rather than the button's own node: avoids waiting on this component's own
  render/mount timing, and avoids a create+append+remove per resolution.
*/
let probeEl = null
function resolveCssColorHex(colorName) {
  if (typeof document === 'undefined') {
    return null
  }
  if (!probeEl) {
    probeEl = document.createElement('span')
    probeEl.style.position = 'absolute'
    probeEl.style.visibility = 'hidden'
    probeEl.style.pointerEvents = 'none'
    document.body.appendChild(probeEl)
  }
  probeEl.style.backgroundColor = `var(--color-${colorName})`
  return parseCssColor(getComputedStyle(probeEl).backgroundColor)
}

/*
  Real browsers resolve `var()` down to `rgb()`/`rgba()`; some test environments hand back the
  already-hex value unchanged, which is passed through as-is. A fully-transparent read is
  `background-color`'s initial value -- what an unresolved CSS variable falls back to -- so it
  returns `null`: nothing was actually resolved.
*/
function parseCssColor(value) {
  if (!value) {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.startsWith('#')) {
    return trimmed
  }
  const match = trimmed.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i
  )
  if (!match) {
    return null
  }
  const [, r, g, b, a] = match
  if (a !== undefined && Number(a) === 0) {
    return null
  }
  const toHex = (n) =>
    Math.max(0, Math.min(255, Math.round(Number(n))))
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/*
  Picks the better-contrasting of white/black against a solid button's resolved background instead of
  always defaulting to white -- several palette colors fall well under WCAG AA (as low as 2.1:1) with
  white text. `props.color` is only ever a custom-property NAME, and the property it resolves to is
  themeable per-site and swapped per CVD mode, so the only place its actual value is knowable is the
  resolved DOM style: there is no static name -> hex table to consult instead.

  Returns `null`, so the caller falls back to white, when `props.color` resolves to nothing; an
  explicit `textColor` bypasses this computed entirely.
*/
const foregroundColor = computed(() => {
  if (!isSolid.value || !props.color || props.textColor) {
    return null
  }
  // -> Re-resolves whenever the app's theme may have changed, with no prop change of its own.
  void themeGeneration.value
  const bg = resolveCssColorHex(props.color)
  if (!bg) {
    return null
  }
  return contrastRatio('#ffffff', bg) >= contrastRatio('#000000', bg) ? '#ffffff' : '#000000'
})

const styles = computed(() => {
  const out = {}

  // -> Set first: the em-based metrics below resolve against it.
  if (props.size) {
    out.fontSize = FONT_SIZES[props.size] ? `${FONT_SIZES[props.size]}px` : props.size
  }

  if (props.round) {
    out.minWidth = props.dense ? '2.4em' : '3em'
    out.minHeight = props.dense ? '2.4em' : '3em'
    out.padding = '0'
  } else {
    out.minHeight = props.dense ? '2.24em' : '2.572em'
    out.padding = props.dense ? '0 0.8em' : '0 1.12em'
  }

  if (props.padding) {
    const [v, h = v] = props.padding.split(/\s+/)
    out.padding = `${SIZES[v] ?? v} ${SIZES[h] ?? h}`
  }

  if (isSolid.value && props.color) {
    out.backgroundColor = `var(--color-${props.color})`
    out.color = props.textColor
      ? `var(--color-${props.textColor})`
      : (foregroundColor.value ?? 'var(--color-white)')
    if (props.color === 'accent') {
      out.boxShadow = 'var(--shadow-primary)'
    }
  } else if (props.color || props.textColor) {
    out.color = `var(--color-${props.textColor ?? props.color})`
  }

  return out
})

function onClick(ev) {
  if (isDisabled.value) {
    ev.preventDefault()
    ev.stopPropagation()
    return
  }
  emit('click', ev)
}
</script>

<style scoped>
/*
  Stated rather than left off, because a <button> and an <a> disagree about the default: the app's
  own reset declares `button, input, select { text-transform: none }` UNLAYERED, which the <button>
  form of this component inherits but the <a> form it takes with `to`/`href` does not -- so with
  nothing said here, a navigating button and an acting button could be capitalised differently by
  whatever an ancestor happened to set. A scoped rule is unlayered too, so it beats that element
  selector without `!important`.
*/
.w-btn {
  text-transform: none;
}

/*
  Every icon in a button, however it got there -- the `icon` prop or the default slot -- so the two
  routes agree: an avatar fallback drawn as slot content at the inherited 1em renders visibly
  smaller than a neighbouring prop-drawn icon. 1.715em is the button's line height; a caller can
  still override per icon, since `size` renders as an inline font-size.
*/
.w-btn :deep(.w-icon) {
  font-size: 1.715em;
}
</style>
