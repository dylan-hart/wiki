<template>
  <teleport to="body">
    <!--
      Single wrapper root, so a class on `<w-dialog>` reaches the markup and can style the backdrop
      and panel by descent (`.main-overlay > .w-dialog-backdrop`). Kept mounted while closed so the
      leave transition has somewhere to run.
    -->
    <div v-bind="$attrs" class="w-dialog-root" :class="modelValue ? 'w-dialog-root--open' : ''">
      <transition name="w-dialog-backdrop">
        <div
          v-if="modelValue"
          class="w-dialog-backdrop fixed inset-0 z-[6000] bg-black/50"
          @click="onBackdropClick" />
      </transition>
      <transition :name="transitionName" @after-leave="$emit('hide')">
        <!--
          `overflow-x-hidden`, not `overflow-auto` on both axes: this viewport is `fixed inset-0`,
          so the right-slide transition's transient `translateX(32px)` past the right edge reads as
          real horizontal scroll and flashes a page-wide scrollbar. Nothing here legitimately needs
          horizontal scroll -- `.w-dialog-panel`'s `max-width: calc(100vw - 2rem)` (`tailwind.css`)
          keeps the panel from outgrowing the viewport, transitions included.
        -->
        <div
          v-if="modelValue"
          class="w-dialog-viewport fixed inset-0 z-[6000] flex flex-nowrap overflow-x-hidden overflow-y-auto pointer-events-none"
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

/** Owns the backdrop, positioning, transition and dismissal only; content comes from the slot. */
/*
  A `<teleport>` root gets no attribute fallthrough -- Vue cannot know which of the teleported
  nodes an attribute belongs to -- so `class` on `<w-dialog>` is bound explicitly on the wrapper.
*/
defineOptions({ inheritAttrs: false })

const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false
  },
  persistent: {
    type: Boolean,
    default: false
  },
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
  /** Any CSS length. Ignored when `fullWidth` is set. */
  maxWidth: {
    type: String,
    default: null
  },
  /** Any CSS length. Ignored when `fullWidth` is set; wins over `maxWidth` when both are given. */
  width: {
    type: String,
    default: null
  },
  /** Any CSS length. Ignored when `fullHeight` is set. */
  height: {
    type: String,
    default: null
  },
  /**
   * Id of an element (typically a `WCardHeader`'s exposed `headingId`) that names this dialog.
   * An explicit prop, not a fallthrough attribute: with `inheritAttrs: false` a bare
   * `aria-labelledby` lands on the teleport root's `$attrs` binding instead of the
   * `role="dialog"` panel, naming the wrong element. Same for `ariaLabel` below.
   */
  labelledBy: {
    type: String,
    default: null
  },
  ariaLabel: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['update:modelValue', 'hide'])

const panelRef = ref(null)

const TRANSITIONS = {
  right: 'w-dialog-slide-right',
  bottom: 'w-dialog-slide-bottom',
  standard: 'w-dialog-scale'
}

/*
  `p-3` insets the right-hand side panel from the window edges, which is what lets its corners be
  rounded: a radius against the very edge of the window reads as a rendering fault, not a shape.

  `justify-center-safe`, not plain `justify-center`: plain centering of a panel wider than the
  viewport centers the OVERFLOW too, pushing the panel's start edge off-screen with no way back to
  it -- and the viewport deliberately has no horizontal scroll to fall back on. `-safe` switches to
  start-alignment exactly when the content would overflow.
*/
const VIEWPORTS = {
  right: 'items-stretch justify-end p-3',
  bottom: 'items-end justify-center',
  standard: 'items-center justify-center-safe p-4'
}

const transitionName = computed(() => TRANSITIONS[props.position] ?? TRANSITIONS.standard)

const viewportClasses = computed(() => VIEWPORTS[props.position] ?? VIEWPORTS.standard)

const panelClasses = computed(() => [
  // -> `rounded-dialog`/`rounded-t-dialog` track the theme's `--radius-dialog` rather than a fixed
  //    Tailwind rung, so a theme can flatten dialogs to 0. A panel against the bottom edge keeps
  //    its own bottom corners square, since they sit on that edge.
  props.position === 'right' ? 'h-full rounded-dialog' : '',
  props.position === 'bottom' ? 'rounded-b-none max-h-full rounded-t-dialog' : '',
  props.position === 'standard' ? 'rounded-dialog max-h-full' : '',
  props.fullHeight && props.position === 'standard' ? 'h-full' : '',
  props.fullWidth ? 'w-full' : ''
])

const panelStyle = computed(() => {
  const style = {}
  if (!props.fullWidth) {
    if (props.width) {
      style.width = props.width
    } else if (props.maxWidth) {
      style.maxWidth = props.maxWidth
    }
  }
  if (!props.fullHeight && props.height) {
    style.height = props.height
  }
  return Object.keys(style).length ? style : undefined
})

function close() {
  emit('update:modelValue', false)
}

function onBackdropClick() {
  if (!props.persistent) {
    close()
  }
}

/*
  Tab-trapping only -- Escape goes through the shared stack `handleEscape` below registers into.
  A raw capture-phase `document` listener is fine for Tab: no nested popup needs to intercept it
  first, which is the problem only Escape has.
*/
function onKeydown(ev) {
  if (ev.key === 'Tab' && isTopmost()) {
    trapTab(ev)
  }
}

/**
 * Registered on the shared stack (`composables/escapeStack.js`) rather than as a `document`
 * listener of its own: both `WDialog` and a nested `WMenu` dropdown teleport to `<body>`, so DOM
 * containment cannot express "the menu is inside the dialog" and only the stack can make the
 * innermost popup handle Escape first. Declining (`return false`) while `persistent` is what lets
 * a `WMenu` opened inside a persistent dialog still close on its own Escape.
 */
function handleEscape() {
  if (props.persistent) {
    return false
  }
  close()
}

/**
 * The panel is teleported to `<body>`, so the element `aria-modal="true"` promises is inert has to
 * be the app root itself -- not an ancestor that, post-teleport, no longer contains the dialog.
 */
function getAppRoot() {
  return document.getElementById('app')
}

/*
  This dialog's own depth, captured the moment it opened -- compared against the live counter to
  tell whether a later dialog has since stacked on top, since Tab must cycle within only the
  topmost dialog.
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

function getFocusable() {
  const panel = panelRef.value
  if (!panel) {
    return []
  }
  return Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR))
}

/**
 * Called from the `flush: 'post'` watcher below, so the panel (mounted by `v-if="modelValue"`) is
 * already in the DOM and this needs no tick of its own. That synchronousness is also what makes
 * `composables/dialog.js`'s `autofocus` a true override rather than a race: its
 * `onMounted -> nextTick -> nextTick` chain necessarily resolves in a later microtask, so its
 * `.focus()` always lands after this default placement.
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

function restoreFocus() {
  if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
    previouslyFocused.focus()
  }
  previouslyFocused = null
}

function trapTab(ev) {
  const panel = panelRef.value
  if (!panel) {
    return
  }
  const focusable = getFocusable()
  if (focusable.length === 0) {
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

// -> Tracks whether THIS instance is the one that incremented wDialogDepth, so its release paths
// can only ever hand back a lock it actually took: `{ immediate: true }` below runs the watcher
// once at mount for every instance, including one that mounts closed.
const hasLocked = ref(false)

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
 * dialogs do not each keep a listener alive. The scroll lock and `inert` are reference-counted on a
 * shared data attribute because a dialog can open on top of another -- releasing on the first close
 * would unlock/un-inert the page while a dialog is still up. Every dialog places and restores its
 * own focus regardless of depth (each is its own trigger/return pair), but only the topmost traps
 * Tab.
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
  //    already in the DOM, and a `pre` callback runs before that render.
  { immediate: true, flush: 'post' }
)

onBeforeUnmount(() => {
  // -> An unmount while open (route change, host teardown) would otherwise leak all four:
  //    the keydown listener, the scroll lock, `inert` on the app root, and the trigger's focus.
  if (hasLocked.value) {
    releaseLock()
  }
})
</script>

<style scoped>
/*
  The panel's own `overflow-auto` (set in the template) is what actually rounds a dialog: the
  opaque bands its content carries -- a header, a row of actions -- would otherwise paint over its
  corners. `auto` rather than `hidden` so content taller than the screen stays reachable.
*/
/*
  The surface inside takes the panel's shape. Without this its own smaller radius shows through at
  the corners as four notches of backdrop, since the panel has no background of its own.

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
  32px and not `100%`: a percentage resolves against the panel's OWN width, and the side panel's
  content arrives asynchronously -- the width changes mid-transition, the percentage re-resolves
  against the new value, and the panel lurches instead of sliding. The fade is what keeps so short
  a move from reading as a pop.
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
