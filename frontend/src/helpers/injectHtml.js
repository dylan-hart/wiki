/**
 * Admin → Theme's raw HTML injection (`siteStore.theme.injectHead` / `injectBody`).
 *
 * `applyTheme()` runs repeatedly in this SPA for reasons unrelated to code injection (a route's
 * first navigation, the CVD-palette watcher, an unrelated theme save), so re-executing the markup's
 * `<script>` tags on every call would depart from server-rendered injection, where they run once per
 * document load. `lastApplied` is what leaves the container — and the scripts it already ran —
 * untouched unless the markup itself changed.
 */

const lastApplied = new Map()

/**
 * `innerHTML` parses `<script>` tags into inert elements the browser will never run; only a real DOM
 * insertion executes one, so each is re-created and swapped in place.
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

export function applyInjectHead(html) {
  applyInjectHtml(document.head, 'theme-inject-head', html)
}

export function applyInjectBody(html) {
  applyInjectHtml(document.body, 'theme-inject-body', html)
}
