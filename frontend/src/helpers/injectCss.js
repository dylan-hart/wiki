/**
 * Callers re-apply their `<style>` on every theme change. Removing first is what makes that a
 * replacement rather than a stack of duplicates; passing no CSS leaves no empty `<style>` behind.
 */
export function replaceHeadStyle(id, css) {
  document.querySelector(`#${id}`)?.remove()

  if (!css) {
    return
  }

  const styleEl = document.createElement('style')
  styleEl.id = id
  styleEl.textContent = css
  document.head.appendChild(styleEl)
}

/**
 * Admin → Theme's raw CSS (`siteStore.theme.injectCSS`), applied verbatim: unscoped and
 * unsandboxed. It sits behind the same `manage:sites` trust boundary that already permits arbitrary
 * SVG upload, so there is no sandboxing to add here.
 */
export function applyInjectCss(css) {
  replaceHeadStyle('theme-inject-css', css)
}
