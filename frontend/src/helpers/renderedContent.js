import { BUNDLED_ICONS } from '@/assets/icons.generated'

import { copyToClipboard } from './clipboard'
import { enhanceContentImageZoom } from './contentImageZoom'
import { isServerPath } from './serverPaths'
import { notify } from '@/composables/notify'

/**
 * The affordances a rendered page grows once it is on screen: a copy button on every code block, and a
 * pilcrow on every heading that copies a link to it.
 *
 * Scripted rather than rendered, because a page's HTML arrives through `v-html`: there is no template
 * to put a component in, and no Vue instance inside the render to hang one off. So the same treatment
 * is applied to whatever the render just produced -- in the page view and in the editor's preview
 * alike, both of which call `enhanceRenderedContent` after the content changes.
 *
 * Idempotent: a decorated element is marked, so re-running over content that has not been replaced
 * adds nothing. The controls carry their own listeners and are discarded wholesale when `v-html` next
 * writes over them, which is why nothing has to be torn down.
 */

/** Drawn from the same inlined set the interface uses; see `scripts/generate-icons.mjs`. */
const ICON_COPY = 'tabler:copy'
const ICON_DONE = 'tabler:check'

/** How long a control reports success before offering itself again. */
const COPIED_FOR_MS = 1600

/**
 * An inlined icon as SVG markup.
 *
 * `WIcon` does this in a template; a control built in script cannot use it, so the same record is read
 * directly. Missing icons are impossible in practice -- the names above are literals, so the generator
 * bundles them -- but an empty string is a nicer failure than a broken template string.
 */
function iconSvg(name) {
  const icon = BUNDLED_ICONS[name]
  if (!icon) {
    return ''
  }
  return `<svg viewBox="0 0 ${icon.width} ${icon.height}" width="16" height="16" aria-hidden="true" focusable="false">${icon.body}</svg>`
}

/**
 * Copy, then have the control say so itself: a toast for something this small would be noise, and the
 * pointer is already on the thing that changed.
 */
async function copyWithFeedback({ text, control, restingLabel, restingHtml, doneLabel, t }) {
  try {
    await copyToClipboard(text)
  } catch (err) {
    notify({ type: 'negative', message: t('common.clipboard.failure'), caption: err.message })
    return
  }

  control.classList.add('is-copied')
  control.innerHTML = iconSvg(ICON_DONE)
  setLabel(control, doneLabel)
  clearTimeout(control._resetTimer)
  control._resetTimer = setTimeout(() => {
    control.classList.remove('is-copied')
    control.innerHTML = restingHtml
    setLabel(control, restingLabel)
  }, COPIED_FOR_MS)
}

/**
 * One string for the two things that have to say it: the accessible name, and the tooltip a control
 * draws for itself (see `.heading-anchor::after`). `data-tooltip` is absent on controls whose icon
 * already says what they do, and the stylesheet then has nothing to render.
 */
function setLabel(control, label) {
  control.setAttribute('aria-label', label)
  if (control.dataset.tooltip !== undefined) {
    control.dataset.tooltip = label
  }
}

/** The code as the author wrote it, without the line numbers the gutter draws. */
function codeOf(pre) {
  const code = pre.querySelector('code')
  if (!code) {
    return pre.textContent
  }
  /*
    Cloned so the gutter can be dropped without touching what is on screen. Its spans hold no text --
    the numbers are drawn by a counter -- but the clone keeps the copy honest if that ever changes.
  */
  const copy = code.cloneNode(true)
  for (const gutter of copy.querySelectorAll('.line-numbers-rows')) {
    gutter.remove()
  }
  return copy.textContent.replace(/\n$/, '')
}

/**
 * Lifts a highlighted block's language onto the `<pre>` as `data-lang`.
 *
 * The renderer already names it, but only as a `language-*` class on the `<code>` INSIDE the block
 * (`renderers/markdown.js`), and CSS cannot read a class's suffix into a `content` string. Cobalt's
 * code block carries the language as a mono label in its top-right corner
 * (`ui-redesign-cobalt/HANDOFF.md`, "Code blocks"), which `_page-contents.scss` draws off this
 * attribute; Ledger's block has no label and simply never selects on it.
 *
 * Done here rather than in `renderers/markdown.js` because the render is STORED: a page saved
 * before this shipped carries the old HTML, and this pass runs over every page as it is displayed.
 *
 * @param {HTMLElement} pre The `<pre class="codeblock">` element.
 */
function tagCodeLanguage(pre) {
  const code = pre.querySelector('code')
  const match = code && /(?:^|\s)language-([\w+#-]+)/.exec(code.className)
  if (match) {
    pre.dataset.lang = match[1]
  }
}

/**
 * One CSV field, RFC4180-quoted when it needs to be: wrapped in double quotes, with any embedded
 * double quote doubled, whenever the raw text contains a comma, a quote, or a newline -- the three
 * characters that would otherwise be ambiguous with the format's own delimiters.
 */
function csvField(text) {
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/**
 * A rendered table's rows, serialized as CSV -- one line per `[role="row"]`, in document order,
 * each cell's trimmed text run through `csvField`.
 *
 * `renderers/markdown.js`'s table overrides (OpenProject #2997/#3014) render a table as CSS Grid --
 * `div[role="table"]` > `div[role="row"]` > `div[role="columnheader"/"cell"]` -- rather than
 * `<table>`/`<tr>`/`<th>`/`<td>`, so this reads role attributes, not tag names.
 *
 * A dedicated walk rather than a reuse of `codeOf()`: a table has no gutter or language concerns,
 * and what it needs quoted is cell text, not a code block's literal source.
 */
function csvOf(table) {
  const lines = []
  for (const row of table.querySelectorAll('[role="row"]')) {
    const cells = row.querySelectorAll('[role="columnheader"], [role="cell"]')
    lines.push(Array.from(cells, (cell) => csvField(cell.textContent.trim())).join(','))
  }
  return lines.join('\n')
}

/**
 * `aria-colspan`/`aria-rowspan` -> real `colspan`/`rowspan`, the reverse of `renderers/markdown.js`'s
 * `asGridCell` rename -- both are always digit-only strings the renderer itself set (from the
 * multimd-table plugin's own parsed span counts), never free text off the page, so there is nothing
 * here to escape.
 */
function spanAttrs(cell) {
  let attrs = ''
  const colspan = cell.getAttribute('aria-colspan')
  const rowspan = cell.getAttribute('aria-rowspan')
  if (colspan) {
    attrs += ` colspan="${colspan}"`
  }
  if (rowspan) {
    attrs += ` rowspan="${rowspan}"`
  }
  return attrs
}

/**
 * A rendered table's rows -- and its caption, if it has one -- serialized as a real
 * `<table>...</table>` HTML string: the clipboard's `text/html` counterpart to `csvOf`, and the
 * reason `event.clipboardData` needs setting by hand at all (OpenProject #3143/#3238). Excel's and
 * Google Sheets' HTML-paste importers key off literal `<table>`/`<tr>`/`<td>` markup (the CF_HTML
 * clipboard convention), not ARIA roles -- see `renderers/markdown.js`'s own "TABLE GRID MARKUP"
 * comment for why the rendered table is a CSS Grid of role-bearing `<div>`s rather than a `<table>`
 * in the first place, and why reconstructing one is cheaper done on demand, at copy time, than by
 * keeping a hidden shadow `<table>` twin of every table's DOM around just in case.
 *
 * Walks `table`'s own direct children -- rows and, if present, a `.table-caption` -- rather than
 * `querySelectorAll`, so only THIS table's structure is read even if a cell somehow nests another
 * table's markup inside it. A cell's `innerHTML` is copied verbatim rather than flattened to
 * `textContent` the way `csvOf`/`tsvOf` do, so a link or bold run inside a cell survives the round
 * trip. A `<caption>` is kept in its authored DOM position: `<table>`'s "in table" insertion mode
 * accepts a `caption` start tag from any of its top-level children, not only the first, and
 * `caption-side` (carried over via the same inline `style` the source div already carries) is what
 * actually decides where it draws either way.
 */
function tableHtmlOf(table) {
  let html = '<table>'
  for (const child of table.children) {
    if (child.getAttribute('role') === 'row') {
      html += '<tr>'
      for (const cell of child.children) {
        const tag = cell.getAttribute('role') === 'columnheader' ? 'th' : 'td'
        const style = cell.getAttribute('style')
        html += `<${tag}${style ? ` style="${style}"` : ''}${spanAttrs(cell)}>${cell.innerHTML}</${tag}>`
      }
      html += '</tr>'
    } else if (child.classList.contains('table-caption')) {
      const style = child.getAttribute('style')
      html += `<caption${style ? ` style="${style}"` : ''}>${child.innerHTML}</caption>`
    }
  }
  html += '</table>'
  return html
}

/**
 * A rendered table's rows, serialized as tab-separated plain text -- the clipboard's `text/plain`
 * fallback alongside `tableHtmlOf`'s `text/html`, read by a paste target that only looks at the
 * plain-text slot. The `csvOf`/`csvField` counterpart for TSV: cell text is trimmed the same way,
 * but TSV has no quoting convention to protect a delimiter character the way `csvField`'s RFC4180
 * quoting does, so a literal tab or newline INSIDE a cell is collapsed to a single space instead of
 * being escaped -- the alternative is that character silently being read back as a column or row
 * break by whatever the TSV is pasted into.
 */
function tsvOf(table) {
  const lines = []
  for (const row of table.querySelectorAll('[role="row"]')) {
    const cells = row.querySelectorAll('[role="columnheader"], [role="cell"]')
    lines.push(
      Array.from(cells, (cell) => cell.textContent.trim().replace(/[\t\r\n]+/g, ' ')).join('\t')
    )
  }
  return lines.join('\n')
}

/**
 * What a table copy puts on the clipboard, kept as its own step separate from finding the table and
 * from the event handling around it -- so OpenProject #3240 (wiring a cell-range select-mode's
 * active range into this same copy handler) can swap only this piece for one that serializes the
 * active range's cell subset instead of always the routine table, rather than rewriting the listener.
 */
function serializeTableForClipboard(table) {
  return { html: tableHtmlOf(table), text: tsvOf(table) }
}

/**
 * The `[role="table"]` a copy's current window selection sits entirely inside, or null when it
 * doesn't -- nothing selected, a collapsed caret, a selection that reaches outside any table, or one
 * that spans two different tables. `handleTableCopy`'s pre-flight for whether to intercept the event
 * at all: anything this returns null for falls through to the browser's own copy exactly as it did
 * before this shipped, which is deliberate -- native browser text selection is linear (one start
 * node/offset to one end node/offset), so it cannot express a two-dimensional cell-range selection
 * anyway (see Epic #3143's own reasoning); this only ever recognizes "the whole table", the one
 * shape a linear selection CAN reliably mean here, and leaves partial cell-range copying to the
 * explicit select-mode UI (#3239/#3240) instead of trying to reconstruct "which cells" from a Range.
 */
function tableForSelection(selection) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null
  }
  let table = null
  for (let i = 0; i < selection.rangeCount; i++) {
    const container = selection.getRangeAt(i).commonAncestorContainer
    const startElement =
      container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement
    const rangeTable = startElement?.closest('[role="table"]')
    if (!rangeTable || (table && rangeTable !== table)) {
      return null
    }
    table = rangeTable
  }
  return table
}

/** The `copy` handler `addTableCopyInterception` wires onto `root`. */
function handleTableCopy(event) {
  if (!event.clipboardData) {
    return
  }
  const table = tableForSelection(window.getSelection())
  if (!table) {
    return
  }
  const { html, text } = serializeTableForClipboard(table)
  event.clipboardData.setData('text/html', html)
  event.clipboardData.setData('text/plain', text)
  event.preventDefault()
}

/**
 * Wires the whole-table copy interception onto `root` itself, once (OpenProject #3143/#3238).
 *
 * Every other pass in this file re-runs over freshly-rendered CHILDREN on every call, idempotent via
 * a per-element dataset flag on each one it decorates -- that works because `v-html` only ever
 * replaces `root`'s children, never `root` itself. A `copy` listener has no per-element home to sit
 * on that way: it has to be on something that stays put across a re-render to keep working at all,
 * which is `root`. So the guard flag lives on `root` directly instead, and the listener is attached
 * exactly once for the element's lifetime rather than once per render pass.
 *
 * Delegated (attached to `root`, not to each table) rather than a per-table listener for the same
 * reason the guard is root-level: a table rendered after this first runs would otherwise get no
 * listener of its own until the next `enhanceRenderedContent` pass happened to re-decorate it, and
 * `copy` bubbles, so one listener on `root` already sees every copy started anywhere under it.
 */
function addTableCopyInterception(root) {
  if (root.dataset.tableCopyWired !== undefined) {
    return
  }
  root.dataset.tableCopyWired = ''
  root.addEventListener('copy', handleTableCopy)
}

function addCodeCopyButtons(root, t) {
  for (const pre of root.querySelectorAll('pre.codeblock:not([data-code-copy])')) {
    // -> Marks the block as done, and is what the stylesheet keys the button's position off
    pre.dataset.codeCopy = ''
    tagCodeLanguage(pre)

    const restingLabel = t('common.renderedContent.copyCode')

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'code-copy'
    setLabel(button, restingLabel)
    button.innerHTML = iconSvg(ICON_COPY)
    button.addEventListener('click', () =>
      copyWithFeedback({
        text: codeOf(pre),
        control: button,
        restingLabel,
        restingHtml: iconSvg(ICON_COPY),
        doneLabel: t('common.renderedContent.copyCodeDone'),
        t
      })
    )

    pre.appendChild(button)
  }
}

/**
 * The per-table copy-to-CSV button, following `addCodeCopyButtons` exactly: marks the wrapper as
 * done, builds a button reusing the same `copyWithFeedback` icon-swap/timeout pattern, and appends
 * it to `.table-wrap` -- the outer frame (see `_page-contents.scss`'s `// TABLES` section), not
 * `.table-scroll`, so the control never travels with the table's own horizontal scroll and is never
 * clipped by the scroller's `overflow-x`.
 */
function addTableCopyButtons(root, t) {
  for (const wrap of root.querySelectorAll('.table-wrap:not([data-table-copy])')) {
    const table = wrap.querySelector('[role="table"]')
    if (!table) {
      continue
    }
    wrap.dataset.tableCopy = ''

    const restingLabel = t('common.renderedContent.copyTable')

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'table-copy'
    setLabel(button, restingLabel)
    button.innerHTML = iconSvg(ICON_COPY)
    button.addEventListener('click', () =>
      copyWithFeedback({
        text: csvOf(table),
        control: button,
        restingLabel,
        restingHtml: iconSvg(ICON_COPY),
        doneLabel: t('common.renderedContent.copyTableDone'),
        t
      })
    )

    wrap.appendChild(button)
  }
}

/**
 * The link a heading's pilcrow copies.
 *
 * Built from the address bar rather than from the page store, so it carries whatever the reader is
 * actually on -- locale prefix included. The editor is the one place where those diverge: it previews a
 * page that lives at its own address, not at `/_edit/…`, so that prefix is dropped.
 *
 * Not a locale parse site -- the locale prefix from the address bar is deliberately preserved.
 */
function headingUrl(id) {
  const path = window.location.pathname.replace(/^\/_edit\//, '/')
  return `${window.location.origin}${path}#${id}`
}

/** The pilcrow, as a character: no icon set carries it, and every font does. */
const PILCROW = '¶'

function addHeadingAnchors(root, t) {
  const headings = 'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'

  for (const heading of root.querySelectorAll(headings)) {
    if (heading.dataset.headingAnchor !== undefined) {
      continue
    }
    heading.dataset.headingAnchor = ''

    const restingLabel = t('common.renderedContent.copyHeadingLink')

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'heading-anchor'
    // -> Declares that this control has a tooltip; `setLabel` keeps the two in step
    button.dataset.tooltip = ''
    setLabel(button, restingLabel)
    button.textContent = PILCROW
    button.addEventListener('click', () =>
      copyWithFeedback({
        text: headingUrl(heading.id),
        control: button,
        restingLabel,
        restingHtml: PILCROW,
        doneLabel: t('common.renderedContent.copyHeadingLinkDone'),
        t
      })
    )

    heading.appendChild(button)
  }
}

/**
 * @param {HTMLElement|null} root The element the render was written into.
 * @param {Function} t vue-i18n translation method
 */
export function enhanceRenderedContent(root, t) {
  if (!root) {
    return
  }
  addCodeCopyButtons(root, t)
  addTableCopyButtons(root, t)
  addTableCopyInterception(root)
  addHeadingAnchors(root, t)
  enhanceContentImageZoom(root, t)
}

/*
  KEYWORD HIGHLIGHT / FIND (OpenProject #2541, Feature #2539)
  =============================================================

  Carries a keyword forward from the knowledge graph's filter into the page the reader lands on:
  every literal, case-insensitive occurrence of the term in the rendered content is wrapped in a
  `<mark>`, with `Index.vue` layering find-like navigation (count, next/prev, auto-scroll) on top of
  the elements this returns.

  A `TreeWalker` over the LIVE text nodes, deliberately not a string regex/replace against the HTML:
  the render arrives as one string only until `v-html` writes it, and splicing the string risks
  matching inside a tag attribute, a URL, or markup `enhanceRenderedContent` above already injected
  (a code-copy button's aria-label, the pilcrow). Walking the real DOM only ever sees text a reader
  can actually read.
*/

/** What marks the `<mark>` wrappers this pass creates as its own, distinct from an author's own
 *  `==term==` markdown -- `_page-contents.scss` already styles a bare `mark`, which this reuses
 *  rather than inventing a second visual language; only the "current match" state adds anything.
 */
const KEYWORD_HIGHLIGHT_ATTR = 'keywordHighlight'
const KEYWORD_HIGHLIGHT_SELECTOR = 'mark[data-keyword-highlight]'

/** Whether a node sits somewhere content should never be scanned for a match, or is already one. */
function skipsKeywordScan(parent) {
  return Boolean(parent?.closest(`script, style, ${KEYWORD_HIGHLIGHT_SELECTOR}`))
}

/** Every text node under `root` worth testing against the term, collected up front. */
function collectHighlightableTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || skipsKeywordScan(node.parentElement)) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })
  const nodes = []
  let node
  while ((node = walker.nextNode())) {
    nodes.push(node)
  }
  return nodes
}

/**
 * Splits one text node on every case-insensitive occurrence of `needle`, replacing it in place with
 * a mix of plain text and new `<mark>` elements -- one per match, in order.
 *
 * A plain `.indexOf` walk against lower-cased copies, not a `RegExp`: the term is arbitrary reader
 * input carried through a query param, and this way it is matched as the literal string it is,
 * with no regex-metacharacter escaping to get right.
 *
 * @returns The `<mark>` elements created, in document order.
 */
function wrapMatchesInTextNode(node, needleLower) {
  const text = node.nodeValue
  const textLower = text.toLowerCase()
  let cursor = 0
  let index = textLower.indexOf(needleLower, cursor)
  if (index === -1) {
    return []
  }

  const marks = []
  const fragment = document.createDocumentFragment()
  while (index !== -1) {
    if (index > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, index)))
    }
    const mark = document.createElement('mark')
    mark.className = 'keyword-highlight'
    mark.dataset[KEYWORD_HIGHLIGHT_ATTR] = ''
    mark.textContent = text.slice(index, index + needleLower.length)
    fragment.appendChild(mark)
    marks.push(mark)
    cursor = index + needleLower.length
    index = textLower.indexOf(needleLower, cursor)
  }
  if (cursor < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(cursor)))
  }
  node.parentNode.replaceChild(fragment, node)
  return marks
}

/**
 * Wrap every literal, case-insensitive match of `term` inside `root` in a new `<mark>`.
 *
 * Always clears any previous pass's wrappers first (a no-op when there are none), so calling this
 * again -- the same term after an unrelated re-render, or a different term while the same content
 * is still on screen -- never nests one `<mark>` inside another. The `TreeWalker`'s own
 * already-wrapped-ancestor skip (`skipsKeywordScan`) is the second, structural half of that: within
 * one pass, a match cannot be found twice, because the elements it just created are never
 * re-visited (`collectHighlightableTextNodes` gathers its list before any mutation begins).
 *
 * @param {HTMLElement|null} root The element the render was written into.
 * @param {string} term The keyword to highlight. A blank or whitespace-only term clears and finds
 *   nothing, same as no term at all.
 * @returns {{ matches: HTMLElement[] }} The `<mark>` elements created, in document order.
 */
export function applyKeywordHighlight(root, term) {
  if (!root) {
    return { matches: [] }
  }
  clearKeywordHighlight(root)

  const needle = typeof term === 'string' ? term.trim() : ''
  if (!needle) {
    return { matches: [] }
  }

  const needleLower = needle.toLowerCase()
  const matches = []
  for (const node of collectHighlightableTextNodes(root)) {
    matches.push(...wrapMatchesInTextNode(node, needleLower))
  }
  return { matches }
}

/** Unwrap every `<mark>` this pass created, merging the text back with its neighbours. */
export function clearKeywordHighlight(root) {
  if (!root) {
    return
  }
  for (const mark of root.querySelectorAll(KEYWORD_HIGHLIGHT_SELECTOR)) {
    const parent = mark.parentNode
    if (!parent) {
      continue
    }
    parent.replaceChild(document.createTextNode(mark.textContent), mark)
    parent.normalize()
  }
}

/**
 * A link's resolved URL, or null when this app has no business intercepting it at all.
 *
 * The half of the decision `routableHref` and `sameDocumentHash` share: an anchor asking for a new
 * context (`target`, `download`, `rel="external"`) is the browser's to handle whatever it points at,
 * and an `href` that is not a URL at all is nobody's. Each of the two then goes on to ask its own
 * question of what comes back.
 *
 * @param {object} link The anchor's own properties: `href` is the resolved absolute URL.
 * @returns {URL|null}
 */
function interceptableUrl({ href, target, download, rel } = {}) {
  if (!href || (target && target !== '_self') || download || /\bexternal\b/.test(rel ?? '')) {
    return null
  }
  try {
    return new URL(href)
  } catch {
    return null
  }
}

/**
 * Where a link inside rendered content should take the reader, if the router should handle it.
 *
 * A page's HTML arrives through `v-html`, so every link in it is a plain anchor: left alone, the
 * browser tears the whole application down and builds it again to show a page the router could have
 * swapped in. This decides which links are worth intercepting, and everything it declines stays
 * exactly as the browser would have treated it.
 *
 * Declined, deliberately:
 *   - another origin, or a scheme that is not http(s) — `mailto:`, `tel:`, a download link
 *   - anything asking for a new context: `target`, `download`, `rel="external"`
 *   - a path the server owns rather than the router
 *   - a fragment on the page already open, which is `sameDocumentHash`'s business instead
 *
 * @param {object} link The anchor's own properties: `href` is the resolved absolute URL.
 * @param {Location|{origin: string, pathname: string}} current Where the reader is now.
 * @returns {string|null} A path to push, or null to let the browser do what it would have done.
 */
export function routableHref(link = {}, current) {
  const url = interceptableUrl(link)
  if (!url) {
    return null
  }
  if (url.origin !== current.origin || !/^https?:$/.test(url.protocol)) {
    return null
  }
  // -> A link to one of these is a request for a file, not a page, and handing it to the router would
  //    render the catch-all page view over the top of nothing
  if (isServerPath(url.pathname)) {
    return null
  }
  // -> Same page, different fragment: nothing to route to, and `sameDocumentHash` handles the scroll
  if (url.pathname === current.pathname && url.hash) {
    return null
  }

  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * The fragment of a link that points at a heading on the page already open, if that is what it is.
 *
 * The counterpart to `routableHref`, which declines these: there is no page to load, only a place on
 * this one to travel to. Left to the browser it is an instant jump, where every other way of reaching
 * a heading in this app animates — the contents list does, and so does arriving with a `#heading` in
 * the URL.
 *
 * Declined on the same grounds as a routable link, so a fragment link asking for a new tab, or
 * carrying `download` / `rel="external"`, is still the browser's to handle.
 *
 * @param {object} link The anchor's own properties: `href` is the resolved absolute URL.
 * @param {Location|{origin: string, pathname: string}} current Where the reader is now.
 * @returns {string|null} The `#fragment` to travel to, or null when this is not such a link.
 */
export function sameDocumentHash(link = {}, current) {
  const url = interceptableUrl(link)
  if (!url) {
    return null
  }
  if (url.origin !== current.origin || !url.hash || url.pathname !== current.pathname) {
    return null
  }

  return url.hash
}
