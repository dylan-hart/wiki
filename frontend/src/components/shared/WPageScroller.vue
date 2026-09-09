<template>
  <transition name="w-page-scroller-fade">
    <div v-if="visible" class="w-page-scroller fixed right-0 bottom-0 z-40" @click="scrollToTop">
      <slot />
    </div>
  </transition>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * "Back to top" affordance that appears once the page has been scrolled past `scrollOffset`, and
 * smooth-scrolls to the top when clicked.
 *
 * Always flush against the bottom-right corner of the viewport. Scrolling uses the platform's own
 * smooth behaviour rather than the hand-rolled easing the previous component shipped, and honours
 * `prefers-reduced-motion` for free.
 *
 * The corner is `right-0`, not `end-0` (OpenProject #1590's physical-positioning triage): this is
 * the corner `MainLayout`/`AdminLayout`'s own sidebar-opener button leaves free for it (see their
 * `left-0`), a pairing with ANOTHER fixed corner rather than with the reading direction, so it must
 * not move when the locale does. See `frontend/src/physicalPositioning.test.js`.
 *
 * OpenProject #2863: this used to also support anchoring flush against the bottom of the nav
 * sidebar's own column (`anchorX`), for `MainLayout`'s wide-viewport (>=1200px) case where the
 * sidebar takes a column beside the page. That mode retired along with its only call site --
 * `MainLayout.vue` no longer mounts this component at all in wide mode, now that the sidebar's own
 * "Top" cell (Feature #2840) covers scroll-to-top there instead -- so the anchored variant is dead
 * code, deleted rather than kept around for a caller that cannot occur.
 */
const props = defineProps({
  /** Show once the window has scrolled this many pixels. */
  scrollOffset: {
    type: Number,
    default: 1000
  },
  /**
   * Selector for the element that scrolls, when it is not the window.
   *
   * The shell is the viewport, so a page view scrolls its own article column rather than the
   * document; this button lives in the shell, outside that column, and so cannot find it by looking
   * upwards. Resolved on each use rather than held, because the element belongs to the routed page
   * and is replaced whenever that changes. Falls back to the window when there is no match.
   */
  target: {
    type: String,
    default: null
  }
})

const visible = ref(false)

/** The scrolling element, or null when it is the window. */
function scroller() {
  return props.target ? document.querySelector(props.target) : null
}

function onScroll() {
  const el = scroller()
  visible.value = (el ? el.scrollTop : window.scrollY) > props.scrollOffset
}

function scrollToTop() {
  // -> `smooth` is ignored when the user has asked for reduced motion, which is the behaviour we want
  ;(scroller() ?? window).scrollTo({ top: 0, behavior: 'smooth' })
}

onMounted(() => {
  // -> `capture`, because a scroll event on an element does not bubble to the window
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })
  onScroll()
})

onBeforeUnmount(() => window.removeEventListener('scroll', onScroll, { capture: true }))
</script>

<style scoped>
/* Fades in and out, which is how every other corner button gives way -- see `.corner-btn` */
.w-page-scroller-fade-enter-active,
.w-page-scroller-fade-leave-active {
  transition: opacity 0.2s var(--ease-standard);
}
.w-page-scroller-fade-enter-from,
.w-page-scroller-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .w-page-scroller-fade-enter-active,
  .w-page-scroller-fade-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
