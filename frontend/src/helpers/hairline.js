/**
 * `.w-hairline` (css/tailwind.css) scales itself by `1 / var(--w-dpr)` so the painted line is one
 * *device* pixel: a 1px CSS rule is 1.5 device pixels at 150% scaling, which renders visibly
 * heavier and disagrees with rules drawn by other mechanisms about how thick "1px" is.
 *
 * There is no CSS unit for a device pixel, so the ratio has to come from script, and it changes
 * with zoom or a move to a differently-scaled monitor -- hence re-read, not sampled once at boot.
 */
export function initializeHairlines() {
  let query = null

  function apply() {
    const dpr = window.devicePixelRatio || 1
    document.documentElement.style.setProperty('--w-dpr', String(dpr))

    /*
      A `(resolution: Xdppx)` query flips the moment the ratio moves, the only reliable
      notification: there is no devicepixelratio event, and `resize` does not fire for every zoom
      step in every browser.
    */
    query?.removeEventListener('change', apply)
    query = window.matchMedia(`(resolution: ${dpr}dppx)`)
    query.addEventListener('change', apply)
  }

  apply()
}
