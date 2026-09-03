<template>
  <span ref="placeholderEl" class="hidden" aria-hidden="true" />
  <teleport to="body">
    <!-- Click-away catcher; transparent, and below the menu itself -->
    <div
      v-if="shown"
      class="fixed inset-0"
      :style="{ zIndex: catcherZ }"
      @click="hide"
      @contextmenu.prevent="hide" />
    <transition name="w-menu">
      <div
        v-if="shown"
        ref="floatEl"
        tabindex="-1"
        v-bind="$attrs"
        class="w-menu fixed overflow-auto rounded shadow-menu"
        :class="[surfaceClass, contentClass]"
        :style="[floatStyle, { zIndex: catcherZ + 1 }]"
        @click="onContentClick"
        @keydown="onPanelKeydown">
        <slot />
      </div>
    </transition>
  </teleport>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { POPUP_CLOSE } from '@/composables/popup'
import { useAnchoredFloat } from '@/composables/anchoredFloat'
import { pushEscapeHandler } from '@/composables/escapeStack'

/*
  The root is a fragment -- an inline placeholder that marks the trigger, plus a teleported popup --
  so Vue cannot decide for itself which half an attribute belongs to, and drops it with a warning.

  Everything belongs to the popup. This matters most for `class`: the menu this replaces put its own
  root IN the popup, so `<q-menu class="translucent-menu">` styled the popup, and that spelling is
  all over the app alongside the explicit `content-class`. Forwarding attrs here keeps both working
  rather than leaving the plain-`class` sites silently unstyled.
*/
defineOptions({ inheritAttrs: false })

/*
  Nesting depth, so a menu opened from inside another menu stacks ABOVE it.

  Each menu lays a full-screen catcher just under its own popup to dismiss it on an outside click.
  With one fixed pair of z-indexes for every menu, an inner menu's catcher sits at the same level as
  the outer one's -- and therefore UNDERNEATH the outer menu's content. Clicking the outer panel
  then never reaches the inner catcher, so a select's dropdown inside a menu could only be dismissed
  by clicking somewhere outside the menu entirely.

  Injected from the enclosing menu, if there is one, and re-provided for anything nested deeper.
  Slot content is mounted inside this component's subtree, so a control written between the menu's
  tags still inherits the value.
*/
const POPUP_DEPTH = Symbol.for('w-popup-depth')
const depth = inject(POPUP_DEPTH, 0) + 1
provide(POPUP_DEPTH, depth)

/*
  A way for content rendered inside the menu to dismiss it -- what `v-close-popup` used to do, minus
  the directive. Content mounted through the default slot lives in this component's subtree, so it
  inherits the provide even though it is written at the call site.
*/
provide(POPUP_CLOSE, () => hide())

/**
 * Base 6500, a step per level. Capped so deep nesting cannot climb over the tooltip (7000) and
 * notification (9000) layers, which must stay on top of any menu.
 */
const catcherZ = 6500 + Math.min(depth - 1, 40) * 10

/**
 * Dropdown menu anchored to its parent element, written as the last child of its trigger:
 *
 *   <w-btn :label="t('common.header.language')">
 *     <w-menu auto-close anchor="bottom right" self="top right"> ... </w-menu>
 *   </w-btn>
 *
 * Opens on click by default, or with `context-menu`: on right-click, on a touch long-press, or on
 * the keyboard Context Menu key / Shift+F10.
 */
const props = defineProps({
  /** Two-way open state. Omit to let the menu manage itself from its trigger. */
  modelValue: {
    type: Boolean,
    default: null
  },
  anchor: {
    type: String,
    default: 'bottom left'
  },
  self: {
    type: String,
    default: 'top left'
  },
  /** Extra `[x, y]` displacement in px. */
  offset: {
    type: Array,
    default: () => [0, 0]
  },
  /** Closes as soon as anything inside is clicked. */
  autoClose: {
    type: Boolean,
    default: false
  },
  /** Opens on right-click at the pointer instead of on left-click at the anchor. */
  contextMenu: {
    type: Boolean,
    default: false
  },
  /** Matches the menu's width to the trigger's. */
  fit: {
    type: Boolean,
    default: false
  },
  /** Caps the panel width, so a long option does not stretch the menu across the screen. */
  maxWidth: {
    type: String,
    default: null
  },
  /** Renders the panel dark whatever the app theme, for a menu opened from a dark surface. */
  dark: {
    type: Boolean,
    default: false
  },
  /** Extra classes for the floating panel. */
  contentClass: {
    type: String,
    default: null
  }
})

/*
  `bg-[var(--color-white)]` rather than `bg-white`: see the comment at the top of the template.
*/
const surfaceClass = computed(() =>
  props.dark
    ? 'bg-[var(--color-dark-3)] text-[var(--color-white)]'
    : 'bg-[var(--color-white)] text-[var(--color-black)] dark:bg-dark-3 dark:text-white'
)

const emit = defineEmits(['update:modelValue', 'show', 'hide'])

const shown = ref(false)
const floatEl = ref(null)
const placeholderEl = ref(null)

/** Set for a context menu, where the anchor is the pointer rather than the trigger element. */
let pointerRect = null

/*
  Trigger discovery and placement are shared with WTooltip; what is this menu's own is the sizing it
  does before measuring (fit-to-trigger width, a height that keeps a long menu on screen) and the
  pointer rect a context menu opens against, both of which `beforeMeasure` owns.
*/
const { triggerEl, floatStyle, reposition } = useAnchoredFloat({
  placeholderEl,
  floatEl,
  closest: 'button, a, .w-btn, .w-item',
  anchor: () => props.anchor,
  self: () => props.self,
  offset: () => props.offset,
  beforeMeasure: (panel, trigger) => {
    if (props.fit) {
      panel.style.minWidth = `${trigger.offsetWidth}px`
    }
    // -> Never let a long menu run off the bottom; it scrolls internally instead
    panel.style.maxHeight = `${window.innerHeight - 32}px`
    if (props.maxWidth) {
      panel.style.maxWidth = props.maxWidth
    }
    return pointerRect ?? undefined
  }
})

/*
  Focus management for the teleported panel: it renders at the end of `<body>`, nowhere near its
  trigger in DOM order, so a keyboard user tabbing forward from the trigger would otherwise land on
  whatever unrelated control happens to follow it in the document instead of the menu. `focusReturnEl`
  is whichever element held focus when the menu opened (usually, but not necessarily, `triggerEl` --
  a context menu opens from a right-click that need not have moved focus at all).
*/
let focusReturnEl = null

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusPanel() {
  const panel = floatEl.value
  if (!panel) {
    return
  }
  const firstRow = panel.querySelector(FOCUSABLE_SELECTOR)
  ;(firstRow ?? panel).focus()
}

function restoreFocus() {
  const el = focusReturnEl
  focusReturnEl = null
  // -> Guards a stale reference: unmounted since open, or never focusable to begin with
  if (el && document.contains(el) && typeof el.focus === 'function') {
    el.focus()
  }
}

// -> `modelValue` is opt-in: null means uncontrolled, so only mirror it when actually provided
const isControlled = () => props.modelValue !== null

/**
 * This instance's current registration on the shared Escape stack (`composables/escapeStack.js`),
 * or `null` while closed. Pushed in `show()`, released in `hide()` -- see `handleEscape` and the
 * import above for why this replaced a bare `document` listener (OpenProject #2370).
 */
let releaseEscapeHandler = null

function handleEscape() {
  hide()
}

async function show() {
  if (shown.value) {
    return
  }
  focusReturnEl = document.activeElement
  shown.value = true
  if (isControlled()) {
    emit('update:modelValue', true)
  }
  emit('show')
  releaseEscapeHandler = pushEscapeHandler(handleEscape)
  await reposition()
  focusPanel()
}

function hide() {
  if (!shown.value) {
    return
  }
  shown.value = false
  pointerRect = null
  if (isControlled()) {
    emit('update:modelValue', false)
  }
  emit('hide')
  releaseEscapeHandler?.()
  releaseEscapeHandler = null
  restoreFocus()
}

function toggle() {
  if (shown.value) {
    hide()
  } else {
    show()
  }
}

function onTriggerClick(ev) {
  if (props.contextMenu) {
    return
  }
  ev.stopPropagation()
  toggle()
}

function onTriggerContextMenu(ev) {
  if (!props.contextMenu) {
    return
  }
  ev.preventDefault()
  ev.stopPropagation()
  // -> A zero-size rect at the cursor makes the pointer the anchor point
  pointerRect = { left: ev.clientX, top: ev.clientY, width: 0, height: 0 }
  show()
}

/*
  Touch long-press: the native `contextmenu` event `onTriggerContextMenu` handles is a desktop-only
  gesture (a right-click). Touch has no equivalent unless one is built -- so a context-menu-mode
  trigger gets a second listener pair, held to `pointerType === 'touch'` only, so mouse/pen input
  keeps going through the click/contextmenu handlers unchanged.

  A press starts a timer; it fires the menu open if the finger stays down and (roughly) still for
  the hold duration. Either releasing early or moving far enough to read as a scroll/drag rather
  than a press-and-hold cancels it -- the same trade-off a native long-press gesture makes.
*/
const LONG_PRESS_MS = 500
const LONG_PRESS_MOVE_TOLERANCE = 10

let longPressTimer = null
let longPressStart = null

function clearLongPress() {
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
  longPressStart = null
}

function onTriggerPointerDown(ev) {
  if (!props.contextMenu || ev.pointerType !== 'touch') {
    return
  }
  clearLongPress()
  longPressStart = { x: ev.clientX, y: ev.clientY }
  longPressTimer = setTimeout(() => {
    longPressTimer = null
    const at = longPressStart
    longPressStart = null
    if (!at) {
      return
    }
    // -> Same anchor mechanism a right-click uses: a zero-size rect at the touch point
    pointerRect = { left: at.x, top: at.y, width: 0, height: 0 }
    show()
  }, LONG_PRESS_MS)
}

function onTriggerPointerMove(ev) {
  if (!longPressStart || ev.pointerType !== 'touch') {
    return
  }
  const dx = ev.clientX - longPressStart.x
  const dy = ev.clientY - longPressStart.y
  if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) {
    clearLongPress()
  }
}

function onTriggerPointerUp(ev) {
  if (ev.pointerType !== 'touch') {
    return
  }
  clearLongPress()
}

/*
  Keyboard: the Context Menu key (`ev.key === 'ContextMenu'`) and the Shift+F10 fallback are the two
  conventional ways to ask for a context menu without a pointer at all. Handled explicitly rather
  than relying on the browser's own keyboard-invoked `contextmenu` event, since that path is
  unreliable across platforms (notably absent on macOS/Safari, which has neither key). Opens anchored
  to the trigger itself -- no `pointerRect` set -- the same placement a plain click-triggered menu
  already uses.
*/
function onTriggerKeydown(ev) {
  if (!props.contextMenu) {
    return
  }
  if (ev.key !== 'ContextMenu' && !(ev.shiftKey && ev.key === 'F10')) {
    return
  }
  ev.preventDefault()
  ev.stopPropagation()
  pointerRect = null
  show()
}

function onContentClick() {
  if (props.autoClose) {
    hide()
  }
}

const ROW_SELECTOR = '[tabindex="0"], a[href]'

/**
 * The panel's own focusable rows, in DOM order. `WItem` puts `tabindex="0"` on a clickable
 * non-anchor row and renders a disabled or non-interactive row with neither a tab stop nor an
 * `href` -- so this selector already excludes both without checking `aria-disabled` itself.
 */
function focusableRows() {
  if (!floatEl.value) {
    return []
  }
  return Array.from(floatEl.value.querySelectorAll(ROW_SELECTOR))
}

/**
 * Up/Down/Home/End roving focus between the panel's rows, wrapping at both ends. Any other key is
 * left alone -- neither `preventDefault` nor `stopPropagation` -- so it still reaches whatever a
 * row itself does with it (e.g. `WItem`'s own Enter/Space handling).
 */
function onPanelKeydown(ev) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) {
    return
  }
  const rows = focusableRows()
  if (rows.length === 0) {
    return
  }
  ev.preventDefault()

  const currentIndex = rows.indexOf(document.activeElement)
  let nextIndex
  if (ev.key === 'Home') {
    nextIndex = 0
  } else if (ev.key === 'End') {
    nextIndex = rows.length - 1
  } else if (ev.key === 'ArrowDown') {
    nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % rows.length
  } else {
    nextIndex =
      currentIndex === -1 ? rows.length - 1 : (currentIndex - 1 + rows.length) % rows.length
  }
  rows[nextIndex].focus()
}

watch(
  () => props.modelValue,
  (v) => {
    if (v === null || v === shown.value) {
      return
    }
    if (v) {
      show()
    } else {
      hide()
    }
  }
)

onMounted(() => {
  // -> `useAnchoredFloat`'s own `onMounted` has already resolved the trigger by this point
  if (!triggerEl.value) {
    return
  }
  /*
    Only bind the trigger when uncontrolled. With `v-model` the parent already toggles the state on
    the same click, and binding here too would toggle twice -- opening and immediately closing.
  */
  if (!isControlled()) {
    triggerEl.value.addEventListener('click', onTriggerClick)
    triggerEl.value.addEventListener('contextmenu', onTriggerContextMenu)
    triggerEl.value.addEventListener('pointerdown', onTriggerPointerDown)
    triggerEl.value.addEventListener('pointermove', onTriggerPointerMove)
    triggerEl.value.addEventListener('pointerup', onTriggerPointerUp)
    triggerEl.value.addEventListener('pointercancel', onTriggerPointerUp)
    triggerEl.value.addEventListener('keydown', onTriggerKeydown)
  }
  window.addEventListener('resize', hide)

  if (props.modelValue === true) {
    show()
  }
})

onBeforeUnmount(() => {
  if (triggerEl.value) {
    triggerEl.value.removeEventListener('click', onTriggerClick)
    triggerEl.value.removeEventListener('contextmenu', onTriggerContextMenu)
    triggerEl.value.removeEventListener('pointerdown', onTriggerPointerDown)
    triggerEl.value.removeEventListener('pointermove', onTriggerPointerMove)
    triggerEl.value.removeEventListener('pointerup', onTriggerPointerUp)
    triggerEl.value.removeEventListener('pointercancel', onTriggerPointerUp)
    triggerEl.value.removeEventListener('keydown', onTriggerKeydown)
  }
  clearLongPress()
  window.removeEventListener('resize', hide)
  // -> An unmount while still shown (route change, host teardown) would otherwise leak this
  //    instance's registration on the shared Escape stack -- `hide()`'s own release runs only on
  //    the ordinary close paths, none of which fire on an unmount.
  releaseEscapeHandler?.()
  releaseEscapeHandler = null
})

/*
  `updatePosition` is part of the contract callers rely on: a menu whose content changes height
  (NavEditMenu adds and removes rows) has to be re-anchored, or it drifts off its trigger.
*/
defineExpose({ show, hide, toggle, updatePosition: reposition })
</script>

<style scoped>
.w-menu-enter-active,
.w-menu-leave-active {
  transition:
    opacity 0.12s var(--ease-standard),
    transform 0.12s var(--ease-standard);
}
.w-menu-enter-from,
.w-menu-leave-to {
  opacity: 0;
  transform: scale(0.96);
}

@media (prefers-reduced-motion: reduce) {
  .w-menu-enter-active,
  .w-menu-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
