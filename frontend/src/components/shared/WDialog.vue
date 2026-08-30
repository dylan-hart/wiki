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
import { computed, onBeforeUnmount, nextTick, ref, watch } from 'vue'

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
*/
const VIEWPORTS = {
  right: 'items-stretch justify-end p-3',
  bottom: 'items-end justify-center',
  standard: 'items-center justify-center p-4'
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

// FOCUS TRAP

const panelRef = ref(null)

/** The element focused right before this dialog opened -- restored to it on close/unmount. */
let previouslyFocusedElement = null

/**
 * This instance's own `wDialogDepth` value, captured the moment it opens. Comparing it against the
 * live counter is how `trapTabKey()` tells whether it is the topmost of a stack of open dialogs --
 * every open dialog's `keydown` listener runs on every keypress (they all target `document`), so a
 * dialog underneath the top one has to recognise that and get out of the way rather than fight it
 * for the Tab key.
 */
let myDepth = 0

/*
  Elements Tab can reach natively. `[tabindex]:not([tabindex="-1"])` picks up anything an author
  opted into or out of the sequence explicitly; the panel's own `tabindex="-1"` (see the template)
  is why that exclusion matters -- without it the panel would count as one of its own tabbable
  descendants.
*/
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function isElementVisible(el) {
  const style = getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function getTabbableElements() {
  if (!panelRef.value) {
    return []
  }
  return Array.from(panelRef.value.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isElementVisible)
}

/**
 * Places initial focus once the panel has rendered. Skipped if focus has already landed somewhere
 * inside the panel by the time this runs -- which is what lets a dialog's own `useDialogComponent({
 * autofocus })` win the race and put focus on a specific field instead of the first tabbable one,
 * without this needing to know that composable exists.
 */
function focusInitialElement() {
  if (!panelRef.value || panelRef.value.contains(document.activeElement)) {
    return
  }
  const [first] = getTabbableElements()
  ;(first ?? panelRef.value).focus()
}

function restoreFocus() {
  const target = previouslyFocusedElement
  previouslyFocusedElement = null
  if (target && typeof target.focus === 'function' && document.contains(target)) {
    target.focus()
  }
}

/** Cycles Tab/Shift+Tab between the panel's first and last tabbable descendants. */
function trapTabKey(ev) {
  if (myDepth !== Number(document.body.dataset.wDialogDepth ?? 0)) {
    // -> Not the topmost dialog -- leave the key for whichever one is
    return
  }
  const tabbable = getTabbableElements()
  if (tabbable.length === 0) {
    ev.preventDefault()
    panelRef.value?.focus()
    return
  }
  const first = tabbable[0]
  const last = tabbable[tabbable.length - 1]
  const active = document.activeElement
  if (ev.shiftKey) {
    if (active === first || !panelRef.value.contains(active)) {
      ev.preventDefault()
      last.focus()
    }
  } else if (active === last || !panelRef.value.contains(active)) {
    ev.preventDefault()
    first.focus()
  }
}

// METHODS

function close() {
  emit('update:modelValue', false)
}

function onBackdropClick() {
  if (!props.persistent) {
    close()
  }
}

function onKeydown(ev) {
  if (ev.key === 'Escape' && !props.persistent) {
    // -> Stops the key also reaching a dialog underneath this one
    ev.stopPropagation()
    close()
    return
  }
  if (ev.key === 'Tab') {
    trapTabKey(ev)
  }
}

/**
 * The panel is teleported to `<body>`, so the element `aria-modal="true"` promises is inert has to be
 * the app root itself (`#app` in `index.html`) -- not some ancestor that, post-teleport, no longer
 * contains the dialog at all.
 */
function getAppRoot() {
  return document.getElementById('app')
}

// WATCHERS

/**
 * Escape handling, focus trapping, scroll-locking and backgrounding are bound only while open, so
 * stacked dialogs do not each keep a listener alive. The scroll lock and `inert` are reference-counted
 * on the same data attribute because a dialog can open on top of another -- releasing on the first
 * close would unlock/un-inert the page while a dialog is still up. The same counter makes the dialog
 * depth-aware for focus: only the topmost one captures/restores focus and traps Tab. Only the
 * outermost dialog (depth 0 -> 1 opening, 1 -> 0 closing) actually toggles `inert`; a stacked dialog
 * just rides the existing count.
 */
watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) {
      previouslyFocusedElement = document.activeElement
      document.addEventListener('keydown', onKeydown, true)
      const depth = Number(document.body.dataset.wDialogDepth ?? 0) + 1
      document.body.dataset.wDialogDepth = String(depth)
      myDepth = depth
      document.body.style.overflow = 'hidden'
      // -> Waits for the panel's v-if to actually render before looking for content inside it
      nextTick(() => focusInitialElement())
      if (depth === 1) {
        getAppRoot()?.setAttribute('inert', '')
      }
    } else {
      document.removeEventListener('keydown', onKeydown, true)
      const depth = Math.max(0, Number(document.body.dataset.wDialogDepth ?? 0) - 1)
      document.body.dataset.wDialogDepth = String(depth)
      if (depth === 0) {
        document.body.style.overflow = ''
        getAppRoot()?.removeAttribute('inert')
      }
      restoreFocus()
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  // -> An unmount while open (route change, host teardown) would otherwise leak all three
  if (props.modelValue) {
    document.removeEventListener('keydown', onKeydown, true)
    const depth = Math.max(0, Number(document.body.dataset.wDialogDepth ?? 0) - 1)
    document.body.dataset.wDialogDepth = String(depth)
    if (depth === 0) {
      document.body.style.overflow = ''
      getAppRoot()?.removeAttribute('inert')
    }
    restoreFocus()
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
