<template>
  <component
    :is="tagName"
    v-bind="linkAttrs"
    :class="classes"
    :tabindex="isInteractive && !isAnchor ? 0 : undefined"
    :role="isInteractive && !isAnchor ? 'button' : undefined"
    :aria-disabled="isDisabled || undefined"
    @click="onClick"
    @keydown="onKeydown">
    <slot />
  </component>
</template>

<script setup>
import { computed } from 'vue'

/**
 * A row in a `WList`: an optional leading section, a main section, and an optional trailing
 * section, supplied as `WItemSection` children.
 *
 * Simplification: the ripple the previous implementation drew on press is replaced by a hover and
 * active background tint. It reads the same at a glance without the extra DOM and animation
 * bookkeeping a ripple needs.
 */
const props = defineProps({
  /** Gives the row hover/press feedback and makes it keyboard-operable. */
  clickable: {
    type: Boolean,
    default: false
  },
  /** Renders as a `router-link`; implies `clickable`. */
  to: {
    type: [String, Object],
    default: null
  },
  /**
   * Renders as a plain `<a>`; implies `clickable`. For an address this app does not route -- another
   * site, a `mailto:` -- which `to` cannot carry: the router would try to match it as a path.
   */
  href: {
    type: String,
    default: null
  },
  /** `_blank` and the rest, for an `href` row. `rel` follows from it. */
  target: {
    type: String,
    default: null
  },
  /** Applied when `to` matches the current route. */
  activeClass: {
    type: String,
    default: null
  },
  /** Forces the active styling on a non-link item. */
  active: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  /** Reduced height. */
  dense: {
    type: Boolean,
    default: false
  },
  /** Underlying element when this is not a link. */
  tag: {
    type: String,
    default: 'div'
  }
})

const emit = defineEmits(['click'])

// COMPUTED

const isDisabled = computed(() => props.disabled)

const isInteractive = computed(
  () => (props.clickable || Boolean(props.to || props.href)) && !isDisabled.value
)

// -> Either kind of link renders an <a>, which is what needs no tab stop or `role` of its own
const isAnchor = computed(() => Boolean(props.to || props.href) && !isDisabled.value)

/*
  Whether the row should look clickable.

  Wider than `isInteractive`, because a `tag="label"` row is operable without this component doing
  anything: the browser forwards a click on a <label> to the control inside it, which is how the
  settings rows toggle their switch from anywhere along the row. That is invisible without a
  cursor and a hover tint -- the row looks inert and the affordance goes unnoticed.

  Deliberately NOT folded into `isInteractive`: that one also adds `role="button"` and a tab stop,
  which on a label wrapping a switch would announce a button around a switch and put two stops in
  the tab order for one control.
*/
const showsAffordance = computed(
  () => (isInteractive.value || props.tag === 'label') && !isDisabled.value
)

// -> A disabled link must stop being a link, or the browser will still navigate on click
const tagName = computed(() => {
  if (!isAnchor.value) {
    return props.tag
  }
  return props.to ? 'router-link' : 'a'
})

const linkAttrs = computed(() => {
  if (!isAnchor.value) {
    return {}
  }
  /*
    `target` goes with `href` only, as it does on `WBtn`: a row that opens somewhere else is not the
    router's to swap in, so a caller wanting a new tab asks for a plain link and gets one.
  */
  if (props.to) {
    return { to: props.to, activeClass: props.activeClass ?? undefined }
  }
  return {
    href: props.href,
    target: props.target ?? undefined,
    // -> Never let a new tab keep a handle on this window
    rel: props.target === '_blank' ? 'noopener noreferrer' : undefined
  }
})

const classes = computed(() => [
  /*
    `text-inherit` because a row with `to` renders an <a>, and with no colour of its own it takes
    the user agent's link colour -- which showed as purple for visited routes on the admin sidebar.

    `items-stretch` (the default, stated for the reader) rather than centring: the sections stretch
    to the row's height and centre their own content, which is what lets a child sized `height:
    100%` -- the status lights beside the nav items -- span the full row.
  */
  'w-item flex flex-nowrap items-stretch px-4 text-inherit no-underline',
  props.dense ? 'min-h-8 py-0.5' : 'min-h-12 py-2',
  /*
    `w-item--clickable`, not Tailwind's `cursor-pointer`: Quasar declares that class UNLAYERED and
    `!important`, which no ordinary rule can override -- so the disabled row below could not take
    its cursor back. The class doubles as the marker WList keys its dark-surface hover off.
  */
  showsAffordance.value
    ? 'w-item--clickable hover:bg-black/8 active:bg-black/14 dark:hover:bg-white/14 dark:active:bg-white/22'
    : '',
  isDisabled.value ? 'pointer-events-none opacity-60' : '',
  props.active && props.activeClass ? props.activeClass : ''
])

// METHODS

function onClick(ev) {
  if (isDisabled.value) {
    ev.preventDefault()
    ev.stopPropagation()
    return
  }
  emit('click', ev)
}

/** Keyboard parity for items that are buttons rather than links. */
function onKeydown(ev) {
  if (!isInteractive.value || isAnchor.value) {
    return
  }
  if (ev.key === 'Enter' || ev.key === ' ') {
    // -> Space would otherwise scroll the page
    ev.preventDefault()
    emit('click', ev)
  }
}
</script>

<style lang="scss" scoped>
/*
  RESPONSIVE ROW STACKING (OpenProject #2822)
  =============================================
  A settings-style row (an icon/label section beside an input section) runs out of room whenever
  something ELSE has squeezed the row -- a nav rail, a sidebar, a narrow dialog -- not necessarily
  the viewport itself. `container-type: inline-size` makes `.w-item` a query container keyed off
  its own rendered width, so `WItemSection`'s stacking rule (see that component, and its matching
  comment) reacts to the row actually running out of room rather than to `window.innerWidth`, and
  works the same way in every `WItem` row in the app instead of being one dialog's local,
  viewport-based copy.

  `flex-wrap: wrap` here is UNCONDITIONAL, not itself behind a container query -- a same-element
  container query (`.w-item` querying its own container) was tried first and verified, in a real
  browser, to never actually take effect: Chromium silently leaves a query container's own styling
  unaffected by a query against itself, so a rule inside `@container w-item { .w-item { ... } }`
  never applied no matter how narrow the row was measured. Leaving `flex-wrap: wrap` permanently on
  is not a workaround for that -- it is inert on its own: every `WItemSection` here defaults to
  `flex: 1 1 0%` (a zero flex-basis), and the flex line-wrapping algorithm decides whether to break
  onto a new line from items' flex-BASIS sizes, not their post-shrink rendered width, so a row of
  zero-basis sections never wraps regardless of how little room they end up sharing. The ONLY thing
  that ever asks this row to wrap is `WItemSection`'s own container query giving a stacked section a
  flex-basis of 100% -- which is also what proves this is still driven by the row's real width, not
  by `flex-wrap` alone: without that companion rule matching, nothing here ever produces a second
  line.
*/
.w-item {
  container-type: inline-size;
  container-name: w-item;
  flex-wrap: wrap;
}

.w-item--clickable {
  cursor: pointer;
}

/*
  A row whose control is disabled offers nothing to click, so it must not look clickable -- a
  `tag="label"` row is only interactive because the browser forwards its click to that control,
  and a disabled control ignores it.

  Detected from the DOM with `:has()` rather than a prop, so the row cannot fall out of step with
  the control it wraps: there is nothing at the call site to remember to update.
*/
.w-item--clickable:has(:disabled) {
  cursor: default;
}

@media (hover: hover) {
  .w-item:has(:disabled):hover {
    background-color: transparent;
  }
}
</style>
