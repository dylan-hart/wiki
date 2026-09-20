import { computed, reactive, ref } from 'vue'

/**
 * The `body--dark` / `body--light` class on <body> is the source of truth, and what
 * `css/tailwind.css` keys the `dark:` variant off. A module-level ref mirrors it because a class on
 * an element outside the app is not reactive by itself, and every caller has to see the same value.
 *
 * `reactive` rather than a plain object holding a ref, so `dark.isActive` is the BOOLEAN in a
 * template as well as in script. Vue only auto-unwraps refs bound at the top level of `setup`; a
 * ref reached through a property stays a ref object -- and a ref object is always truthy, so
 * `dark.isActive ? a : b` in a template would silently take the same branch for ever.
 */

/** Seeded from the DOM, so a class set before the app booted is not lost. */
const active = ref(
  typeof document !== 'undefined' && document.body.classList.contains('body--dark')
)

/**
 * Suppresses every CSS transition for the one frame the theme class flips in. Without it, a control
 * whose color comes from a `transition-colors` utility animates from its light-mode color to its
 * dark-mode one instead of switching instantly. `tailwind.css`'s `.theme-transition-suppress` rule
 * forces `transition: none !important` on every element while that class sits on `<html>`.
 */
function withoutTransitions(fn) {
  const root = document.documentElement
  root.classList.add('theme-transition-suppress')
  fn()

  /*
   * Load-bearing: forces a synchronous style recalc so the browser commits the new colors WHILE
   * transitions are still off. `requestAnimationFrame` callbacks run BEFORE style recalc/paint for
   * their frame, so without this read the suppress class could be gone before the new styles
   * resolve -- letting the fade play anyway.
   */
  void getComputedStyle(document.body).transitionDuration

  requestAnimationFrame(() => {
    root.classList.remove('theme-transition-suppress')
  })
}

function apply(value) {
  withoutTransitions(() => {
    active.value = value === true
    document.body.classList.toggle('body--dark', active.value)
    document.body.classList.toggle('body--light', !active.value)
  })
}

export function useDark() {
  const isActive = computed(() => active.value)

  return reactive({
    /** @type {boolean} */
    isActive,

    /** @param {boolean} value */
    set(value) {
      apply(value)
    },

    toggle() {
      apply(!active.value)
    }
  })
}
