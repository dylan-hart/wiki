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
    <!-- Held at full size but invisible while loading, so the button does not resize mid-request -->
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

/**
 * Button.
 *
 * Variants mirror the four the app uses: raised (default), `flat`, `unelevated` and `push`.
 * Content comes from the `label` prop, the default slot, or both.
 */
const props = defineProps({
  label: {
    type: [String, Number],
    default: null
  },
  /** Icon reference, drawn before the label. See `WIcon`. */
  icon: {
    type: String,
    default: null
  },
  /**
   * Theme or palette color name (`primary`, `negative`, `grey-7`, ...), resolved against the
   * Tailwind color variables. Drives the background for solid variants, the text for flat ones.
   */
  color: {
    type: String,
    default: null
  },
  /** Overrides the foreground color independently of `color`. */
  textColor: {
    type: String,
    default: null
  },
  /** No background or shadow until hovered. */
  flat: {
    type: Boolean,
    default: false
  },
  /** Border and text in `color`, with no fill. */
  outline: {
    type: Boolean,
    default: false
  },
  /** Circular icon-only button. */
  round: {
    type: Boolean,
    default: false
  },
  /** Pill-shaped button. */
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
  /** Reduced padding. */
  dense: {
    type: Boolean,
    default: false
  },
  /**
   * Padding override, as Quasar wrote it: one or two size names or CSS lengths, vertical first
   * (`xs md`, `sm`, `none`).
   */
  padding: {
    type: String,
    default: null
  },
  /** Swaps the content for a spinner and blocks clicks. */
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
  /** Renders as a `router-link`. */
  to: {
    type: [String, Object],
    default: null
  },
  /** Renders as an `<a>`. */
  href: {
    type: String,
    default: null
  },
  target: {
    type: String,
    default: null
  },
  /** Native tooltip. */
  title: {
    type: String,
    default: null
  },
  /**
   * Native `tabindex`, e.g. `-1` to remove an otherwise-focusable button from the tab order (a
   * decorative preview control that isn't a real link, say) without also having to give it a fake
   * accessible name.
   */
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

// COMPUTED

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
      // -> Never let a new tab keep a handle on this window
      rel: props.target === '_blank' ? 'noopener noreferrer' : undefined
    }
  }
  return {}
})

// -> Both flat and outline are unfilled; only the border distinguishes them
const isSolid = computed(() => !props.flat && !props.outline)

/*
  Cardinal geometry: a 32px band, square, with a 12.5px/500 label.

    font-size 12.5px · line-height 1.715em · padding 0 1.12em (14px) · dense padding 0 0.8em
    min-height 2.572em (32.15px), 2.24em dense (28px) · round 3em / 2.4em dense, unpadded
    border-radius 0 -- except `round` (a circle) and `rounded` (a pill), which are shapes a caller
    asks for, not a corner style

  `2.572em` is carried over from the metrics this replaces rather than recomputed: at Cardinal's
  12.5px it lands on the design's 32px band, and at 14px it lands on the 36px band the app used to
  draw, so a caller that overrides `size` keeps a proportionate button either way. Every metric is
  em-relative for the same reason -- one `size` value scales padding, height and icon together.

  No shadow and no gloss. Cardinal separates a control from its ground with a hairline, never with
  elevation -- so `unelevated`, `push` and `glossy` are gone along with `noCaps`, each having named a
  variant that is now the only one there is. A solid button IS unelevated; a label IS cased as
  written.
*/
const classes = computed(() => [
  props.size ? 'leading-[1.715em]' : 'text-[12.5px] leading-[1.715em]',
  props.round ? 'rounded-full' : props.rounded ? 'rounded-[28px]' : 'rounded-none',
  // -> The hairline, not `border-current`: an outlined button's edge is chrome, its label is not
  props.outline ? 'border border-hairline dark:border-border-dark' : '',
  isDisabled.value ? 'pointer-events-none opacity-60' : 'cursor-pointer',
  // -> Flat buttons have no background of their own, so hover tints with the current text color
  isSolid.value ? 'hover:brightness-110' : 'hover:bg-current/10'
])

/*
  Bumped by `applyTheme` (`App.vue`), fired on a theme edit, a dark/light appearance switch and a
  CVD-mode change -- each rewrites the `--color-*` custom properties `foregroundColor` below resolves
  against, with no prop of this button changing, so nothing would otherwise tell it to re-resolve.
*/
const themeGeneration = ref(0)
function onThemeApplied() {
  themeGeneration.value++
}
onMounted(() => EVENT_BUS.on('applyTheme', onThemeApplied))
onUnmounted(() => EVENT_BUS.off('applyTheme', onThemeApplied))

/*
  One hidden, reused probe element rather than reading the button's own node: avoids waiting on this
  component's own render/mount timing, and avoids a create+append+remove per resolution.
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
  Normalizes a `getComputedStyle` background-color read to a hex string `contrastRatio` can consume.
  Real browsers resolve `var()` down to `rgb()`/`rgba()`; some test environments hand back the
  already-hex value unchanged, which is passed through as-is. Returns `null` for a fully-transparent
  read (`rgba(0, 0, 0, 0)`, `background-color`'s initial value) -- what an unresolved/undefined CSS
  variable falls back to -- since that means nothing was actually resolved.
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
  Picks the better-contrasting of white/black against a solid button's actual resolved background,
  instead of always defaulting to white -- several palette colors (the seeded accent `#FF9800`,
  `warning`, `secondary`/`positive`'s teal, ...) fall well under WCAG AA (as low as 2.1:1) with white
  text. `props.color` is only ever a CSS custom-property NAME here (`primary`, `grey-7`, ...), not a
  color value: the property it resolves to is themeable per-site and swapped per CVD mode
  (`helpers/cssVars.js`), so the only place its actual value is knowable is the resolved DOM style --
  there is no static name -> hex table this could consult instead.

  Returns `null` (falls back to white, the prior fixed behavior) when `props.color` doesn't resolve
  to anything -- an explicit `textColor` bypasses this computed entirely, per its own contract.
*/
const foregroundColor = computed(() => {
  if (!isSolid.value || !props.color || props.textColor) {
    return null
  }
  // -> Re-resolves whenever the app's theme may have changed, even with no prop change of its own
  void themeGeneration.value
  const bg = resolveCssColorHex(props.color)
  if (!bg) {
    return null
  }
  return contrastRatio('#ffffff', bg) >= contrastRatio('#000000', bg) ? '#ffffff' : '#000000'
})

const styles = computed(() => {
  const out = {}

  // -> Set first: the em-based metrics below resolve against it
  if (props.size) {
    out.fontSize = FONT_SIZES[props.size] ? `${FONT_SIZES[props.size]}px` : props.size
  }

  // -> A round button is sized by its min box and never padded; anything else follows the scale
  if (props.round) {
    out.minWidth = props.dense ? '2.4em' : '3em'
    out.minHeight = props.dense ? '2.4em' : '3em'
    out.padding = '0'
  } else {
    out.minHeight = props.dense ? '2.24em' : '2.572em'
    out.padding = props.dense ? '0 0.8em' : '0 1.12em'
  }

  // -> An explicit `padding` prop overrides the variant default, as it did before
  if (props.padding) {
    const [v, h = v] = props.padding.split(/\s+/)
    out.padding = `${SIZES[v] ?? v} ${SIZES[h] ?? h}`
  }

  if (isSolid.value && props.color) {
    out.backgroundColor = `var(--color-${props.color})`
    out.color = props.textColor
      ? `var(--color-${props.textColor})`
      : (foregroundColor.value ?? 'var(--color-white)')
  } else if (props.color || props.textColor) {
    out.color = `var(--color-${props.textColor ?? props.color})`
  }

  return out
})

// METHODS

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
  Capitalisation, stated rather than inherited.

  Cardinal sets a button label in sentence case -- "Save changes", not "SAVE CHANGES"; uppercase is
  reserved for the Roboto Mono chrome overlines (a section header, a status mark), which are not
  buttons. It has to be written here rather than simply left off, because a <button> and an <a>
  disagree about the default: the app's own reset declares `button, input, select { text-transform:
  none }` UNLAYERED, which is inherited by the <button> form of this component but not by the <a>
  form it takes with `to`/`href` -- so with nothing said here, a navigating button and an acting
  button could still be capitalised differently by whatever an ancestor happened to set.

  A scoped rule, which is unlayered too, so it beats that element selector without `!important`.
*/
.w-btn {
  text-transform: none;
}

/*
  Every icon in a button, however it got there -- the `icon` prop or the default slot. Sized here
  rather than on the prop icon alone so the two routes agree: AccountMenu draws its avatar fallback
  as slot content, and at the inherited 1em it rendered visibly smaller than the neighbouring
  header buttons that use the prop.

  1.715em is the button's line height, which is what the button this replaces used. A caller can
  still override per icon, since `size` renders as an inline font-size.
*/
.w-btn :deep(.w-icon) {
  font-size: 1.715em;
}
</style>
