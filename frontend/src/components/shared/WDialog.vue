<template>
  <teleport to="body">
    <!--
      Single wrapper root, so a class on `<w-dialog>` reaches the markup and can style the backdrop
      and panel by descent (`.main-overlay > .w-dialog-backdrop`). A multi-root component gets no
      attribute fallthrough at all, which left overlays unable to carry their own styling.

      The wrapper is always present but empty while closed -- an empty div with no positioning has
      no layout or paint cost, and keeping it mounted means the leave transition has somewhere to
      run.
    -->
    <div v-bind="$attrs" class="w-dialog-root" :class="modelValue ? 'w-dialog-root--open' : ''">
      <transition name="w-dialog-backdrop">
        <div
          v-if="modelValue"
          class="w-dialog-backdrop fixed inset-0 z-[6000] bg-black/50"
          @click="onBackdropClick" />
      </transition>
      <transition :name="transitionName" @after-leave="$emit('hide')">
        <div
          v-if="modelValue"
          class="w-dialog-viewport fixed inset-0 z-[6000] flex flex-nowrap overflow-auto pointer-events-none"
          :class="viewportClasses">
          <div
            ref="panelRef"
            role="dialog"
            aria-modal="true"
            tabindex="-1"
            :aria-labelledby="labelledBy"
            :aria-label="ariaLabel"
            class="w-dialog-panel pointer-events-auto flex flex-col overflow-auto shadow-dialog"
            :class="panelClasses"
            :style="panelStyle"
            @click.stop>
            <slot />
          </div>
        </div>
      </transition>
    </div>
  </teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { pushEscapeHandler } from '@/composables/escapeStack'

/**
 * Modal dialog shell.
 *
 * Covers the two placements the app uses -- a centered modal, and the right-hand side panel that
 * `SideDialog` opens. Content, including its own header/actions, comes from the default slot; this
 * component owns only the backdrop, positioning, transition and dismissal behaviour.
 */
/*
  A `<teleport>` root gets no attribute fallthrough -- Vue cannot know which of the teleported
  nodes an attribute belongs to -- so a `class` on `<w-dialog>` was being dropped with a warning
  rather than reaching the markup the overlay stylesheets select on. Bound explicitly instead.
*/
defineOptions({ inheritAttrs: false })

const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false
  },
  /** Blocks dismissal via backdrop click and Escape. */
  persistent: {
    type: Boolean,
    default: false
  },
  /**
   * `standard` centers the panel, `right` docks it to the right edge as a side panel, `bottom`
   * anchors it to the bottom of the viewport.
   */
  position: {
    type: String,
    default: 'standard',
    validator: (v) => ['standard', 'right', 'bottom'].includes(v)
  },
  fullHeight: {
    type: Boolean,
    default: false
  },
  fullWidth: {
    type: Boolean,
    default: false
  },
  /** Any CSS length, e.g. `550px`. Ignored when `fullWidth` is set. */
  maxWidth: {
    type: String,
    default: null
  },
  /**
   * Id of an element (typically a `WCardHeader`'s exposed `headingId`) that names this dialog for
   * assistive tech. Explicit props, not fallthrough attributes: `inheritAttrs: false` above sends a
   * bare `aria-labelledby`/`aria-label` attribute to the teleport root's `$attrs` binding instead of
   * the `role="dialog"` panel, naming the wrong element.
   */
  labelledBy: {
    type: String,
    default: null
  },
  /** A literal accessible name, for a dialog whose heading isn't in the DOM (or doesn't exist). */
  ariaLabel: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['update:modelValue', 'hide'])

const panelRef = ref(null)

// COMPUTED

const TRANSITIONS = {
  right: 'w-dialog-slide-right',
  bottom: 'w-dialog-slide-bottom',
  standard: 'w-dialog-scale'
}

/*
  `p-3` on the right-hand viewport is what insets the side panel from the window edges instead of
  butting it against them, which is also what lets its corners be rounded: a radius against the very
  edge of the window reads as a rendering fault rather than a shape.

  The standard viewport centers with `justify-center-safe`, not plain `justify-center`: a plain
  `center` on a panel wider than the viewport (a card's inline `min-width` past the
  `.w-dialog-panel` clamp's own floor) centers the OVERFLOW too, pushing the panel's start edge
  off-screen in both directions with no way to scroll back to it. `-safe` falls back to
  start-alignment exactly when the content would overflow, so the start edge stays put at the
  viewport edge and reachable through the `overflow-auto` above, while a panel that fits still
  centers as before.
*/
const VIEWPORTS = {
  right: 'items-stretch justify-end p-3',
  bottom: 'items-end justify-center',
  standard: 'items-center justify-center-safe p-4'
}

const transitionName = computed(() => TRANSITIONS[props.position] ?? TRANSITIONS.standard)

const viewportClasses = computed(() => VIEWPORTS[props.position] ?? VIEWPORTS.standard)

const panelClasses = computed(() => [
  // -> Rounded, not square: the panel no longer touches the window, see VIEWPORTS above. A panel
  //    against the bottom edge keeps its own bottom corners square, since they sit on that edge.
  props.position === 'right' ? 'h-full rounded-lg' : '',
  props.position === 'bottom' ? 'rounded-b-none max-h-full rounded-t-lg' : '',
  props.position === 'standard' ? 'rounded-lg max-h-full' : '',
  props.fullHeight && props.position === 'standard' ? 'h-full' : '',
  props.fullWidth ? 'w-full' : ''
])

const panelStyle = computed(() =>
  !props.fullWidth && props.maxWidth ? { maxWidth: props.maxWidth } : undefined
)

// METHODS

function close() {
  emit('update:modelValue', false)
}

function onBackdropClick() {
  if (!props.persistent) {
    close()
  }
}

/*
  Tab-trapping only -- Escape is handled separately, through the shared stack `handleEscape` below
  registers into (OpenProject #2370). This stays a raw, capture-phase `document` listener because Tab
  is never something a nested popup needs to intercept first; only Escape has that cascading-consumer
  problem.
*/
function onKeydown(ev) {
  if (ev.key === 'Tab' && isTopmost()) {
    trapTab(ev)
  }
}

/**
 * This dialog's own Escape handling, registered on the shared stack (`composables/escapeStack.js`)
 * rather than as a `document` listener of its own. That stack is what makes "let the innermost
 * popup handle Escape first" hold regardless of DOM position -- both `WDialog` and a nested `WMenu`
 * dropdown teleport to `<body>`, so DOM containment cannot express "the menu is inside the dialog"
 * at all, and a `document`-level CAPTURE listener (this used to be one) fires before a bubble-phase
 * one on any node, so it always won even when opened first. Declining (`return false`) while
 * `persistent` is what lets a `WMenu` opened inside a persistent dialog still close on its own
 * Escape -- this handler never consumes the keypress at all in that case.
 */
function handleEscape() {
  if (props.persistent) {
    return false
  }
  close()
}

/**
 * The panel is teleported to `<body>`, so the element `aria-modal="true"` promises is inert has to be
 * the app root itself (`#app` in `index.html`) -- not some ancestor that, post-teleport, no longer
 * contains the dialog at all.
 */
function getAppRoot() {
  return document.getElementById('app')
}

/*
  This dialog's own depth, captured the moment it opened -- compared against the live counter to tell
  whether a later dialog has since stacked on top. Tab must cycle within only the topmost dialog; an
  outer one still holds a real depth but is no longer the frontmost panel.
*/
let ownDepth = 0
let previouslyFocused = null

function isTopmost() {
  return Number(document.body.dataset.wDialogDepth ?? 0) === ownDepth
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]'
].join(',')

/** Tabbable descendants of the panel, in document order -- the panel itself is never included. */
function getFocusable() {
  const panel = panelRef.value
  if (!panel) {
    return []
  }
  return Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR))
}

/**
 * Moves focus into the panel: its first tabbable descendant, or the panel itself (`tabindex="-1"`)
 * when it has none. Called from the `flush: 'post'` watcher below, which is what lets this run with
 * no tick of its own to wait out -- the panel (mounted by `v-if="modelValue"`) already exists in the
 * DOM by the time a post-flush callback runs, unlike the default `pre` timing every other watcher in
 * this file still uses for the (DOM-independent) scroll lock and `inert` bookkeping.
 *
 * That synchronousness is also what makes `composables/dialog.js`'s `autofocus` a true override
 * rather than a race: its own `onMounted -> nextTick -> nextTick` chain necessarily resolves in a
 * later microtask than a same-flush, synchronous callback, so its `.focus()` always lands after --
 * and therefore wins over -- this default placement.
 */
function placeInitialFocus() {
  previouslyFocused = document.activeElement
  const [first] = getFocusable()
  if (first) {
    first.focus()
  } else {
    panelRef.value?.focus()
  }
}

/** Returns focus to whatever had it before the dialog opened -- the trigger, in the common case. */
function restoreFocus() {
  if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
    previouslyFocused.focus()
  }
  previouslyFocused = null
}

/** Cycles Tab/Shift+Tab between the panel's first and last tabbable descendants. */
function trapTab(ev) {
  const panel = panelRef.value
  if (!panel) {
    return
  }
  const focusable = getFocusable()
  if (focusable.length === 0) {
    // -> Nothing to cycle between; keep focus pinned to the panel itself
    ev.preventDefault()
    panel.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const withinPanel = panel.contains(document.activeElement)
  if (ev.shiftKey) {
    if (!withinPanel || document.activeElement === first) {
      ev.preventDefault()
      last.focus()
    }
  } else if (!withinPanel || document.activeElement === last) {
    ev.preventDefault()
    first.focus()
  }
}

// WATCHERS

// -> Tracks whether THIS instance is the one that incremented wDialogDepth, so its release path
// (the watcher's else-branch, and onBeforeUnmount) can only ever hand back a lock it actually took.
// `{ immediate: true }` below runs the watcher once at mount for every instance, including one that
// mounts closed -- without this flag that immediate run would decrement a counter it never touched.
const hasLocked = ref(false)

/** This instance's release from the shared Escape stack -- see `handleEscape` above. */
let releaseEscapeHandler = null

function releaseLock() {
  document.removeEventListener('keydown', onKeydown, true)
  releaseEscapeHandler?.()
  releaseEscapeHandler = null
  const depth = Math.max(0, Number(document.body.dataset.wDialogDepth ?? 0) - 1)
  document.body.dataset.wDialogDepth = String(depth)
  if (depth === 0) {
    document.body.style.overflow = ''
    getAppRoot()?.removeAttribute('inert')
  }
  restoreFocus()
  hasLocked.value = false
}

/**
 * Escape handling, scroll-locking, backgrounding and focus are bound only while open, so stacked
 * dialogs do not each keep a listener alive. Both the scroll lock and `inert` are reference-counted on
 * the same data attribute because a dialog can open on top of another -- releasing on the first close
 * would unlock/un-inert the page while a dialog is still up. Only the outermost dialog (depth 0 -> 1
 * opening, 1 -> 0 closing) actually toggles `inert`; a stacked dialog just rides the existing count.
 * Every dialog places and restores its own focus regardless of depth (each is its own trigger/return
 * pair), but only the topmost one traps Tab -- `ownDepth` records each instance's own depth at open
 * time, and `isTopmost()` compares it against the live counter.
 */
watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) {
      document.addEventListener('keydown', onKeydown, true)
      releaseEscapeHandler = pushEscapeHandler(handleEscape)
      const depth = Number(document.body.dataset.wDialogDepth ?? 0) + 1
      document.body.dataset.wDialogDepth = String(depth)
      ownDepth = depth
      document.body.style.overflow = 'hidden'
      if (depth === 1) {
        getAppRoot()?.setAttribute('inert', '')
      }
      placeInitialFocus()
      hasLocked.value = true
    } else if (hasLocked.value) {
      releaseLock()
    }
  },
  // -> `post`, not the default `pre`: `placeInitialFocus()` needs the panel (`v-if="modelValue"`)
  //    already in the DOM, which `pre` timing -- callback runs before this render -- would not give it.
  { immediate: true, flush: 'post' }
)

onBeforeUnmount(() => {
  // -> An unmount while open (route change, host teardown) would otherwise leak all four:
  //    the keydown listener, the scroll lock, `inert` on the app root, and the trigger's focus.
  //    Gated on `hasLocked` (not `props.modelValue`) for the same reason the watcher's close
  //    branch is -- see the comment above `hasLocked`'s declaration.
  if (hasLocked.value) {
    releaseLock()
  }
})
</script>

<style scoped>
/*
  The panel clips what is put inside it, which is what actually rounds a dialog.

  Every dialog fills its panel with something opaque -- a `WCard`, or a whole `WLayout` for the
  full-screen overlays -- and those surfaces carry bands with backgrounds of their own: a header, a row
  of actions. Left to paint themselves, they cover the panel's corners and the dialog reads as square,
  which it did. Clipping here rounds all of them at once, however deeply the band is nested.

  `auto` rather than `hidden`: both clip, but a dialog whose content outgrows the screen stays
  reachable instead of being cut off. The viewport behind it scrolls too, so nothing is trapped.
*/
/*
  The surface inside takes the panel's shape. Without this its own smaller radius shows through at the
  corners as four notches of backdrop, since the panel itself has no background of its own.

  Written flat rather than nested: nesting `> :deep(*)` inside the panel's own rule compiles to a
  DESCENDANT selector, which matches the wrong elements entirely.
*/
.w-dialog-panel > :deep(*) {
  border-radius: inherit;
}

.w-dialog-backdrop-enter-active,
.w-dialog-backdrop-leave-active {
  transition: opacity 0.2s var(--ease-standard);
}
.w-dialog-backdrop-enter-from,
.w-dialog-backdrop-leave-to {
  opacity: 0;
}

.w-dialog-scale-enter-active,
.w-dialog-scale-leave-active {
  transition: opacity 0.2s var(--ease-standard);
}
.w-dialog-scale-enter-active .w-dialog-panel,
.w-dialog-scale-leave-active .w-dialog-panel {
  transition: transform 0.2s var(--ease-standard);
}
.w-dialog-scale-enter-from,
.w-dialog-scale-leave-to {
  opacity: 0;
}
.w-dialog-scale-enter-from .w-dialog-panel,
.w-dialog-scale-leave-to .w-dialog-panel {
  transform: scale(0.94);
}

/*
  A short slide in from the right, paired with a fade so a 32px move does not read as a pop.

  32px and not `100%`: a percentage resolves against the panel's OWN width, and the side panel's
  content arrives asynchronously -- so the width changed mid-transition, the percentage re-resolved
  against the new value, and the panel lurched instead of sliding. A fixed distance cannot move
  underneath the animation.
*/
.w-dialog-slide-right-enter-active,
.w-dialog-slide-right-leave-active {
  transition: opacity 0.2s var(--ease-standard);
}
.w-dialog-slide-right-enter-from,
.w-dialog-slide-right-leave-to {
  opacity: 0;
}
.w-dialog-slide-right-enter-active .w-dialog-panel,
.w-dialog-slide-right-leave-active .w-dialog-panel {
  transition: transform 0.2s var(--ease-standard);
}
.w-dialog-slide-right-enter-from .w-dialog-panel,
.w-dialog-slide-right-leave-to .w-dialog-panel {
  transform: translateX(32px);
}

.w-dialog-slide-bottom-enter-active .w-dialog-panel,
.w-dialog-slide-bottom-leave-active .w-dialog-panel {
  transition: transform 0.25s var(--ease-standard);
}
.w-dialog-slide-bottom-enter-from .w-dialog-panel,
.w-dialog-slide-bottom-leave-to .w-dialog-panel {
  transform: translateY(100%);
}

@media (prefers-reduced-motion: reduce) {
  .w-dialog-backdrop-enter-active,
  .w-dialog-backdrop-leave-active,
  .w-dialog-scale-enter-active,
  .w-dialog-scale-leave-active,
  .w-dialog-scale-enter-active .w-dialog-panel,
  .w-dialog-scale-leave-active .w-dialog-panel,
  .w-dialog-slide-right-enter-active .w-dialog-panel,
  .w-dialog-slide-right-leave-active .w-dialog-panel,
  .w-dialog-slide-bottom-enter-active .w-dialog-panel,
  .w-dialog-slide-bottom-leave-active .w-dialog-panel {
    transition-duration: 0.01ms;
  }
}
</style>
