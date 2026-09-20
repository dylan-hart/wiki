import { ref } from 'vue'

/**
 * Mirrored in `css/tailwind.css` -- keep the two in sync. Note `sm` starts at 600px here, not
 * Tailwind's stock 640px.
 */
const BREAKPOINTS = {
  sm: 600,
  md: 1024,
  lg: 1440,
  xl: 1920
}

/** One shared listener per breakpoint for the whole app: every consumer wants the same answer. */
const queries = new Map()

function queryFor(minWidth) {
  if (!queries.has(minWidth)) {
    const mql = window.matchMedia(`(min-width: ${minWidth}px)`)
    const state = ref(mql.matches)
    mql.addEventListener('change', (ev) => {
      state.value = ev.matches
    })
    queries.set(minWidth, state)
  }
  return queries.get(minWidth)
}

export function useScreen() {
  return {
    gte: {
      get sm() {
        return queryFor(BREAKPOINTS.sm).value
      },
      get md() {
        return queryFor(BREAKPOINTS.md).value
      },
      get lg() {
        return queryFor(BREAKPOINTS.lg).value
      },
      get xl() {
        return queryFor(BREAKPOINTS.xl).value
      }
    }
  }
}

export function useMinWidth(minWidth) {
  // -> The ref is shared app-wide and outlives any one component, so there is nothing to tear down
  return queryFor(minWidth)
}
