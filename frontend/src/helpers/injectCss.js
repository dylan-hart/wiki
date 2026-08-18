/**
 * Live application of Admin → Theme's raw CSS injection (`siteStore.theme.injectCSS`).
 *
 * Mirrors the create-and-remove pattern `App.vue`'s `applyCodeBlocksTheme()` uses for the
 * highlight.js theme: the previous `#theme-inject-css` element is always removed first, and a
 * fresh one is appended only when there is CSS to show. Calling this repeatedly — from the
 * `applyTheme` EVENT_BUS event, or from a watcher that re-runs `applyTheme()` — replaces the
 * element rather than stacking duplicates, and an empty string leaves no `<style>` tag behind at
 * all rather than an empty one.
 *
 * The CSS is applied verbatim: raw, unscoped, unsandboxed. This matches upstream 2.5.x semantics
 * (site-wide CSS applied after system defaults) and sits behind the same `manage:sites` trust
 * boundary that already permits arbitrary SVG upload — there is no sandboxing to add here.
 *
 * @param {string} css Raw CSS from `siteStore.theme.injectCSS`.
 */
export function applyInjectCss(css) {
  document.querySelector('#theme-inject-css')?.remove()

  if (!css) {
    return
  }

  const styleEl = document.createElement('style')
  styleEl.id = 'theme-inject-css'
  styleEl.textContent = css
  document.head.appendChild(styleEl)
}
