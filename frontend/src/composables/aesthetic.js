import { computed, reactive, ref } from 'vue'

/**
 * The `body--ledger` / `body--cobalt` class on <body> is the source of truth -- a second axis fully
 * independent of `composables/dark.js`'s `body--dark` / `body--light`, which this composable never
 * reads or writes. A module-level ref mirrors the class because a class on an element outside the
 * app is not reactive by itself, and every caller has to see the same value.
 *
 * `reactive` rather than a plain object holding a ref: Vue only auto-unwraps a ref bound at the top
 * level of `setup`, and a ref reached through a property stays a ref object elsewhere -- including
 * in a template, where that object is always truthy.
 */

/** Seeded from the DOM, so a class set before the app booted is not lost. */
const current = ref(
  typeof document !== 'undefined' && document.body.classList.contains('body--cobalt')
    ? 'cobalt'
    : 'ledger'
)

/**
 * Duplicated from `dark.js`'s namesake rather than shared: each composable owns exactly one class
 * flip and neither depends on the other running first. Without it, a control whose color comes from
 * a `transition-colors` utility animates from its old aesthetic's color to the new one instead of
 * switching instantly. `tailwind.css`'s `.theme-transition-suppress` rule forces
 * `transition: none !important` on every element while that class sits on `<html>`.
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
    current.value = value === 'cobalt' ? 'cobalt' : 'ledger'
    document.body.classList.toggle('body--cobalt', current.value === 'cobalt')
    document.body.classList.toggle('body--ledger', current.value !== 'cobalt')
  })
}

export function useAesthetic() {
  const currentValue = computed(() => current.value)

  return reactive({
    /** @type {'ledger'|'cobalt'} */
    current: currentValue,

    /** @param {'ledger'|'cobalt'} value */
    set(value) {
      apply(value)
    }
  })
}
