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
 * Row in a `WList`, with `WItemSection` children. Differs from the component it replaces in drawing
 * a hover/active background tint instead of a press ripple -- the same read at a glance, without a
 * ripple's DOM and animation bookkeeping.
 */
const props = defineProps({
  clickable: {
    type: Boolean,
    default: false
  },
  to: {
    type: [String, Object],
    default: null
  },
  /** For an address the router cannot match as a path -- another site, a `mailto:`. */
  href: {
    type: String,
    default: null
  },
  target: {
    type: String,
    default: null
  },
  activeClass: {
    type: String,
    default: null
  },
  active: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  dense: {
    type: Boolean,
    default: false
  },
  tag: {
    type: String,
    default: 'div'
  }
})

const emit = defineEmits(['click'])

const isDisabled = computed(() => props.disabled)

const isInteractive = computed(
  () => (props.clickable || Boolean(props.to || props.href)) && !isDisabled.value
)

// -> Either kind of link renders an <a>, which is what needs no tab stop or `role` of its own
const isAnchor = computed(() => Boolean(props.to || props.href) && !isDisabled.value)

/*
  Wider than `isInteractive`: a `tag="label"` row is operable without this component doing anything,
  since the browser forwards a click on a <label> to the control inside it, and that affordance goes
  unnoticed without a cursor and hover tint. Kept separate because `isInteractive` also adds
  `role="button"` and a tab stop -- on a label wrapping a switch, that announces a button around a
  switch and puts two stops in the tab order for one control.
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
  // -> `target` goes with `href` only, as on `WBtn`: a destination the router swaps in never opens
  //    a new tab, so a caller wanting one asks for a plain link.
  if (props.to) {
    return { to: props.to, activeClass: props.activeClass ?? undefined }
  }
  return {
    href: props.href,
    target: props.target ?? undefined,
    rel: props.target === '_blank' ? 'noopener noreferrer' : undefined
  }
})

const classes = computed(() => [
  /*
    `text-inherit` because a row with `to` renders an <a>, which without a colour of its own takes
    the user agent's link colour -- purple once the route has been visited. `items-stretch` rather
    than centring so a child sized `height: 100%`, such as a nav item's status light, spans the row.
  */
  'w-item flex flex-nowrap items-stretch px-4 text-inherit no-underline',
  props.dense ? 'min-h-8 py-0.5' : 'min-h-12 py-2',
  /*
    `w-item--clickable` carries the cursor rather than Tailwind's `cursor-pointer` so the disabled
    rule below can override it, and it doubles as the marker `WList` and the nav stylesheets key
    their own hover rules off.
  */
  showsAffordance.value
    ? 'w-item--clickable hover:bg-black/8 active:bg-black/14 dark:hover:bg-white/14 dark:active:bg-white/22'
    : '',
  isDisabled.value ? 'pointer-events-none opacity-60' : '',
  props.active && props.activeClass ? props.activeClass : ''
])

function onClick(ev) {
  if (isDisabled.value) {
    ev.preventDefault()
    ev.stopPropagation()
    return
  }
  emit('click', ev)
}

/** Keyboard parity for a row that is a button rather than a link, which the browser handles. */
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

<style scoped>
/*
  A settings-style row runs out of room whenever something ELSE squeezes it -- a nav rail, a
  sidebar, a narrow dialog -- not necessarily the viewport, so `WItemSection`'s stacking rule keys
  off this query container's own rendered width rather than `window.innerWidth`.

  Narrowed with `:has()` to the two-main-section shape rather than applied to every `.w-item`:
  `container-type: inline-size` implies inline-axis size containment, so a row that becomes a query
  container stops contributing to an ancestor's shrink-to-fit width. Harmless in an
  explicitly-sized dialog, fatal for a menu row in a `w-menu` popup with no `matchTrigger`, which
  collapses to its own padding with 0 content width.

  `flex-wrap` cannot itself sit behind the container query: a query container's own styling is
  unaffected by a query against itself, so `@container w-item { .w-item { ... } }` never applies.
  Leaving it on unconditionally is inert -- every `WItemSection` defaults to a zero flex-basis and
  wrapping is decided from flex-basis, not post-shrink width, so only `WItemSection`'s companion
  container query raising a section to a 100% basis ever produces a second line.
*/
.w-item:has(.w-item-section--main + .w-item-section--main) {
  container-type: inline-size;
  container-name: w-item;
  flex-wrap: wrap;
}

.w-item--clickable {
  cursor: pointer;
}

/*
  A `tag="label"` row is interactive only because the browser forwards its click to the control it
  wraps, and a disabled control ignores it. Detected from the DOM with `:has()` rather than a prop
  so the row cannot fall out of step with its control.
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
