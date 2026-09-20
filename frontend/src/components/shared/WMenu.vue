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
  The root is a fragment -- an inline placeholder marking the trigger, plus a teleported popup -- so
  Vue cannot decide which half an attribute belongs to and drops it with a warning. Everything
  belongs to the popup; `class` especially, which call sites use to style the panel alongside the
  explicit `content-class`.
*/
defineOptions({ inheritAttrs: false })

/*
  Nesting depth, so a menu opened from inside another stacks ABOVE it. Each menu lays a full-screen
  catcher just under its own popup; with one fixed pair of z-indexes for every menu, an inner menu's
  catcher sits underneath the outer menu's content, and clicking the outer panel never dismisses the
  inner one.
*/
const POPUP_DEPTH = Symbol.for('w-popup-depth')
const depth = inject(POPUP_DEPTH, 0) + 1
provide(POPUP_DEPTH, depth)

/*
  Lets content dismiss the menu from inside it: slot content is mounted in this component's subtree,
  so it inherits the provide even though it is written at the call site.
*/
provide(POPUP_CLOSE, () => hide())

/** Capped so deep nesting cannot climb over the tooltip (7000) and notification (9000) layers. */
const catcherZ = 6500 + Math.min(depth - 1, 40) * 10

/**
 * Anchored to its parent element, so it is written as the last child of its trigger:
 *
 *   <w-btn :label="t('common.header.language')">
 *     <w-menu auto-close anchor="bottom right" self="top right"> ... </w-menu>
 *   </w-btn>
 */
const props = defineProps({
  /** Two-way open state; omit to let the menu manage itself from its trigger. */
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
  /** Opens on right-click, long-press or Context Menu / Shift+F10 instead of on left-click. */
  contextMenu: {
    type: Boolean,
    default: false
  },
  /** Matches the menu's width to the trigger's. */
  fit: {
    type: Boolean,
    default: false
  },
  maxWidth: {
    type: String,
    default: null
  },
  /** Renders the panel dark whatever the app theme, for a menu opened from a dark surface. */
  dark: {
    type: Boolean,
    default: false
  },
  contentClass: {
    type: String,
    default: null
  }
})

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
  The teleported panel renders at the end of `<body>`, nowhere near its trigger in DOM order, so a
  keyboard user tabbing forward from the trigger lands on whatever follows it in the document unless
  focus is moved explicitly. `focusReturnEl` is whichever element held focus when the menu opened --
  not necessarily `triggerEl`, since a right-click need not have moved focus at all.
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

// -> `null` means uncontrolled, so the prop is mirrored back only when a caller provides it
const isControlled = () => props.modelValue !== null

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
  Touch has no equivalent of the right-click `onTriggerContextMenu` handles, so context-menu mode
  builds one. Held to `pointerType === 'touch'` so mouse and pen input keep going through the
  click/contextmenu handlers unchanged. Releasing early, or moving far enough to read as a scroll
  rather than a press-and-hold, cancels the pending open.
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
  The Context Menu key and the Shift+F10 fallback are handled explicitly rather than through the
  browser's own keyboard-invoked `contextmenu` event, which is unreliable across platforms (absent
  on macOS/Safari, which has neither key). No `pointerRect`, so it anchors to the trigger.
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
 * `WItem` puts `tabindex="0"` on a clickable non-anchor row and gives a disabled or non-interactive
 * row neither a tab stop nor an `href`, so the selector excludes both without checking further.
 */
function focusableRows() {
  if (!floatEl.value) {
    return []
  }
  return Array.from(floatEl.value.querySelectorAll(ROW_SELECTOR))
}

/**
 * Any key other than the four is left alone -- neither `preventDefault` nor `stopPropagation` -- so
 * it still reaches whatever a row itself does with it, such as `WItem`'s Enter/Space handling.
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
    Only bind the trigger when uncontrolled: with `v-model` the parent already toggles the state on
    the same click, so binding here too would toggle twice and close it again immediately.
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
  // -> An unmount while still shown (route change, host teardown) runs no close path, so `hide()`'s
  //    own release never fires and the Escape-stack registration would leak.
  releaseEscapeHandler?.()
  releaseEscapeHandler = null
})

/* `updatePosition` is for a menu whose content changes height: unanchored, it drifts off. */
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
