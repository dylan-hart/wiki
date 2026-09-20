/**
 * Dark mode, for blocks.
 *
 * The app keeps one source of truth for the theme: a `body--dark` / `body--light` class on <body>,
 * set by `frontend/src/composables/dark.js`. CSS inside a shadow root cannot see it. `:host-context()`
 * is exactly the selector for that job, but only Chromium ever shipped it -- MDN has it deprecated,
 * Firefox and Safari have never implemented it, and there the rule simply never matches, leaving a
 * block light on a dark page with nothing to show that anything had gone wrong. So the class is read
 * in JS instead and pushed into the blocks that ask for it, through one observer shared by the whole
 * page.
 */

/** @type {Set<(dark: boolean) => void>} */
const watchers = new Set()
let observer = null

export function isDark() {
  return document.body.classList.contains('body--dark')
}

/**
 * @param {(dark: boolean) => void} onChange
 * @returns {() => void} stops the watching
 */
export function watchTheme(onChange) {
  watchers.add(onChange)
  if (!observer) {
    observer = new MutationObserver(() => {
      const dark = isDark()
      for (const watcher of watchers) {
        watcher(dark)
      }
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  }
  return () => {
    watchers.delete(onChange)
    if (watchers.size < 1) {
      observer?.disconnect()
      observer = null
    }
  }
}

/**
 * A block that only changes colour needs no more than to construct one and write `:host([dark])`,
 * whose specificity sits above the `:host` rule holding the light values. One that has to act on the
 * change rather than restyle for it -- redrawing in a library's own dark theme, say -- passes
 * `onChange`, or reads `isDark` off the controller at the moment it needs it.
 *
 * The attribute goes on the host, the one element a block always has, rather than inside the shadow
 * root: where the shadow tree is a library's to arrange, an attribute bound in `render()` risks
 * being written over -- see the `data-theme` note in `block-map`.
 */
export class DarkMode {
  /**
   * @param {import('lit').ReactiveElement} host
   * @param {{ attribute?: boolean, onChange?: (dark: boolean) => void }} [options]
   *   `attribute: false` for a block that resolves the theme itself and would find a second answer
   *   sitting on the host misleading. `onChange` runs after the host has been told to update.
   */
  constructor(host, { attribute = true, onChange = null } = {}) {
    this.host = host
    this.isDark = isDark()
    this._attribute = attribute
    this._onChange = onChange
    this._unwatch = null
    host.addController(this)
  }

  hostConnected() {
    this._apply(isDark())
    this._unwatch = watchTheme((dark) => this._apply(dark))
  }

  hostDisconnected() {
    this._unwatch?.()
    this._unwatch = null
  }

  _apply(dark) {
    this.isDark = dark
    if (this._attribute) {
      this.host.toggleAttribute('dark', dark)
    }
    this.host.requestUpdate()
    this._onChange?.(dark)
  }
}
