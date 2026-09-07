import { computed, reactive, ref } from 'vue'

/**
 * Aesthetic (Cobalt: aesthetic setting, Feature #2753 / Task #2766).
 *
 * The single source of truth is the `body--ledger` / `body--cobalt` class on <body> -- the second,
 * fully independent axis alongside `composables/dark.js`'s `body--dark` / `body--light`. The two
 * classes combine freely into all four pairs; this composable owns only its own axis and never reads
 * or writes the dark one. A module-level ref mirrors the DOM class so Vue can react: a class on an
 * element outside the app is not reactive by itself, and every caller has to see the same value.
 *
 * `reactive` rather than a plain object holding a ref, for the same reason `dark.js` uses it: Vue
 * only auto-unwraps a ref bound at the top level of `setup`, and a ref reached through a property
 * stays a ref object elsewhere -- including in a template, where that object is always truthy.
 */

/** Seeded from the DOM, so a class set before the app booted is not lost. */
const current = ref(
  typeof document !== 'undefined' && document.body.classList.contains('body--cobalt')
    ? 'cobalt'
    : 'ledger'
)

/**
 * Suppresses every CSS transition for one frame while the aesthetic class flips.
 *
 * Identical to `dark.js`'s `withoutTransitions()` -- duplicated rather than shared, since each
 * composable owns exactly one class flip and neither depends on the other running first. Without
 * this, a control whose color is driven by a `transition-colors` (or similar) utility animates from
 * its old aesthetic's color to the new one instead of switching instantly. `tailwind.css`'s
 * `.theme-transition-suppress` rule forces `transition: none !important` on every element while this
 * class is present on `<html>`; adding it, flipping the class synchronously, then removing it on the
 * next animation frame means the flip itself paints with transitions off, and every transition is
 * back to normal by the very next change.
 */
function withoutTransitions(fn) {
  const root = document.documentElement
  root.classList.add('theme-transition-suppress')
  fn()

  /*
   * Load-bearing: forces a synchronous style recalc so the browser commits the new colors WHILE
   * transitions are still off. `requestAnimationFrame` callbacks run BEFORE style recalc/paint for
   * that frame, so without this read the suppress class could already be gone by the time the browser
   * actually resolves the new styles -- which would let the fade play anyway.
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
