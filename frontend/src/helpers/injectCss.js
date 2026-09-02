/**
 * Replace the `<style>` element carrying `id`, or remove it outright when there is nothing to show.
 *
 * Three theme surfaces write a `<style>` into the head this way -- the raw CSS injection below, the
 * content font (`helpers/fonts.js`) and the code-block theme (`App.vue`) -- and each is re-applied
 * whenever the theme changes. Removing first is what makes that a replacement rather than a stack of
 * duplicates, and passing nothing leaves no empty `<style>` tag behind at all.
 *
 * @param {string} id The element's `id`, without the `#`.
 * @param {string|null} css The stylesheet's text, or nothing to leave the head with no such element.
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
 * Live application of Admin → Theme's raw CSS injection (`siteStore.theme.injectCSS`).
 *
 * The CSS is applied verbatim: raw, unscoped, unsandboxed. This matches upstream 2.5.x semantics
 * (site-wide CSS applied after system defaults) and sits behind the same `manage:sites` trust
 * boundary that already permits arbitrary SVG upload — there is no sandboxing to add here.
 *
 * @param {string} css Raw CSS from `siteStore.theme.injectCSS`.
 */
export function applyInjectCss(css) {
  replaceHeadStyle('theme-inject-css', css)
}
