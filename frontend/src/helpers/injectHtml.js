/**
 * Live application of Admin → Theme's raw HTML injection (`siteStore.theme.injectHead` /
 * `siteStore.theme.injectBody`).
 *
 * Mirrors the create-and-remove pattern `injectCss.js` uses for the CSS override: the previous
 * container is always removed first, and a fresh one is appended — near the end of `<head>` /
 * `<body>` respectively — only when there is markup to show. An empty string is a no-op with the
 * container left removed.
 *
 * In upstream 2.5.x this markup is rendered server-side, directly into the page template, so a
 * `<script>` tag in it runs exactly once as part of normal HTML parsing when the document loads —
 * there is no equivalent of re-applying it later. This app is a SPA that calls `applyTheme()`
 * repeatedly for reasons that have nothing to do with code injection (a route's first navigation,
 * the CVD-palette watcher, an admin saving unrelated theme settings), and `Element.innerHTML` does
 * not execute embedded `<script>` tags at all — browsers only run a `<script>` element inserted via
 * a real DOM insertion (`appendChild`, `replaceWith`, …), never one that merely appears as a result
 * of parsing an `innerHTML` assignment. So the markup is walked after each `innerHTML` assignment
 * and every `<script>` it contains is re-created as a fresh element and reinserted in place, which
 * does execute.
 *
 * The closest match to upstream's "runs once" semantics is to skip that recreation — and the
 * re-execution it causes — when the markup hasn't actually changed since the last call, only
 * re-running scripts when an admin edits and saves `injectHead` / `injectBody` (the one case this
 * app can hit that 2.5.x never could, since 2.5.x has no live re-apply at all). A route change or an
 * unrelated theme tweak calls this again with identical markup and leaves the existing container,
 * and any scripts it already ran, untouched.
 */

const lastApplied = new Map()

/**
 * Re-creates every `<script>` under `container` so it actually executes.
 *
 * `innerHTML` parses `<script>` tags into inert `HTMLScriptElement`s that the browser will never
 * run; creating new script elements and inserting them via `replaceWith` is a real DOM insertion,
 * which does run them — for both inline code and a `src`-based script. All attributes (`src`,
 * `type`, `async`, …) are copied across, and the inline body copied as `textContent`.
 *
 * @param {HTMLElement} container
 */
function reExecuteScripts(container) {
  for (const oldScript of container.querySelectorAll('script')) {
    const newScript = document.createElement('script')
    for (const attr of oldScript.attributes) {
      newScript.setAttribute(attr.name, attr.value)
    }
    newScript.textContent = oldScript.textContent
    oldScript.replaceWith(newScript)
  }
}

/**
 * @param {HTMLElement} root `document.head` or `document.body`.
 * @param {string} containerId Id of the dedicated wrapper element.
 * @param {string} html Raw HTML to inject, or `''` to remove any previous injection.
 */
function applyInjectHtml(root, containerId, html) {
  const existing = document.getElementById(containerId)

  // -> Unchanged since the last call: leave the container, and any scripts it already ran, alone
  if (existing && lastApplied.get(containerId) === html) {
    return
  }

  existing?.remove()
  lastApplied.set(containerId, html)

  if (!html) {
    return
  }

  const container = document.createElement('div')
  container.id = containerId
  container.innerHTML = html
  reExecuteScripts(container)
  root.appendChild(container)
}

/**
 * @param {string} html Raw HTML from `siteStore.theme.injectHead`.
 */
export function applyInjectHead(html) {
  applyInjectHtml(document.head, 'theme-inject-head', html)
}

/**
 * @param {string} html Raw HTML from `siteStore.theme.injectBody`.
 */
export function applyInjectBody(html) {
  applyInjectHtml(document.body, 'theme-inject-body', html)
}
