import { BUNDLED_ICONS } from '@/assets/icons.generated'

import { copyToClipboard } from './clipboard'
import { enhanceContentImageZoom } from './contentImageZoom'
import { isServerPath } from './serverPaths'
import { notify } from '@/composables/notify'

/**
 * The affordances a rendered page grows once it is on screen, scripted rather than rendered because a
 * page's HTML arrives through `v-html`: there is no template to put a component in, and no Vue
 * instance inside the render to hang one off. The same treatment is applied to whatever the render
 * just produced, in the page view and in the editor's preview alike.
 *
 * Idempotent: a decorated element is marked, so re-running over content that has not been replaced
 * adds nothing. The controls carry their own listeners and are discarded wholesale when `v-html` next
 * writes over them, which is why nothing has to be torn down.
 */

const ICON_COPY = 'tabler:copy'
const ICON_DONE = 'tabler:check'

const COPIED_FOR_MS = 1600

/**
 * `WIcon` does this in a template; a control built in script cannot use it, so the same record is
 * read directly. A miss is impossible in practice -- these names are literals, so
 * `scripts/generate-icons.mjs` bundles them -- but an empty string fails more gracefully.
 */
function iconSvg(name) {
  const icon = BUNDLED_ICONS[name]
  if (!icon) {
    return ''
  }
  return `<svg viewBox="0 0 ${icon.width} ${icon.height}" width="16" height="16" aria-hidden="true" focusable="false">${icon.body}</svg>`
}

/**
 * The control reports success itself: a toast for something this small would be noise, and the pointer
 * is already on the thing that changed.
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
 * One string for both the accessible name and the tooltip a control draws for itself (see
 * `.heading-anchor::after`). `data-tooltip` is absent on controls whose icon already says what they
 * do, and the stylesheet then has nothing to render.
 */
function setLabel(control, label) {
  control.setAttribute('aria-label', label)
  if (control.dataset.tooltip !== undefined) {
    control.dataset.tooltip = label
  }
}

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
 * The renderer names the language only as a `language-*` class on the `<code>` INSIDE the block
 * (`renderers/markdown.js`), and CSS cannot read a class's suffix into a `content` string, so
 * `_page-contents.css` draws Cobalt's corner label off `data-lang` instead.
 *
 * Done here rather than in `renderers/markdown.js` because the render is STORED: HTML already in the
 * database never gains the attribute at render time, and this pass runs over every page as displayed.
 */
function tagCodeLanguage(pre) {
  const code = pre.querySelector('code')
  const match = code && /(?:^|\s)language-([\w+#-]+)/.exec(code.className)
  if (match) {
    pre.dataset.lang = match[1]
  }
}

/**
 * RFC4180 quoting: a comma, a double quote or a newline in the text would otherwise be ambiguous with
 * the format's own delimiters.
 */
function csvField(text) {
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/**
 * `renderers/markdown.js`'s table overrides render a table as CSS Grid -- `div[role="table"]` >
 * `div[role="row"]` > `div[role="columnheader"/"cell"]` -- rather than `<table>`/`<tr>`/`<th>`/`<td>`,
 * so this reads role attributes, not tag names.
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
 * `asGridCell` rename. Both are always digit-only strings the renderer itself set from the
 * multimd-table plugin's parsed span counts, never free text off the page, so there is nothing here
 * to escape.
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
 * The clipboard's `text/html` counterpart to `csvOf`, and the reason `event.clipboardData` is set by
 * hand at all: Excel's and Google Sheets' HTML-paste importers key off literal `<table>`/`<tr>`/`<td>`
 * markup (the CF_HTML clipboard convention), not ARIA roles. Rebuilt on demand at copy time rather
 * than by keeping a hidden shadow `<table>` twin of every table around just in case.
 *
 * Walks `table`'s own direct children rather than `querySelectorAll`, so only THIS table's structure
 * is read even if a cell nests another table's markup inside it. A cell's `innerHTML` is copied
 * verbatim rather than flattened to `textContent` the way `csvOf`/`tsvOf` do, so a link or bold run
 * inside a cell survives the round trip. A `<caption>` stays in its authored position: the "in table"
 * insertion mode accepts one from any top-level child, and `caption-side` decides where it draws.
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
 * The clipboard's `text/plain` fallback alongside `tableHtmlOf`'s `text/html`. TSV has no quoting
 * convention to protect a delimiter the way `csvField`'s RFC4180 quoting does, so a literal tab or
 * newline INSIDE a cell is collapsed to a single space -- the alternative is that character being
 * read back as a column or row break by whatever the TSV is pasted into.
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

function serializeTableForClipboard(table) {
  return { html: tableHtmlOf(table), text: tsvOf(table) }
}

/**
 * `tableHtmlOf` over `getActiveTableSelection()`'s rectangle instead of every row. No `<caption>`: one
 * describes the table as a whole, not a range cut out of it.
 */
function tableHtmlOfRange(cells) {
  let html = '<table>'
  for (const cellRow of cells) {
    html += '<tr>'
    for (const cell of cellRow) {
      const tag = cell.getAttribute('role') === 'columnheader' ? 'th' : 'td'
      const style = cell.getAttribute('style')
      html += `<${tag}${style ? ` style="${style}"` : ''}${spanAttrs(cell)}>${cell.innerHTML}</${tag}>`
    }
    html += '</tr>'
  }
  html += '</table>'
  return html
}

function tsvOfRange(cells) {
  return cells
    .map((cellRow) =>
      cellRow.map((cell) => cell.textContent.trim().replace(/[\t\r\n]+/g, ' ')).join('\t')
    )
    .join('\n')
}

function serializeTableRangeForClipboard(range) {
  return { html: tableHtmlOfRange(range.cells), text: tsvOfRange(range.cells) }
}

/**
 * The `[role="table"]` a copy's current window selection sits entirely inside, or null when it
 * doesn't -- nothing selected, a collapsed caret, a selection reaching outside any table, or one
 * spanning two tables. Anything null falls through to the browser's own copy, deliberately: a native
 * selection is linear (one start node/offset to one end), so it cannot express a two-dimensional cell
 * range at all. "The whole table" is the one shape it can reliably mean here; a partial range comes
 * from select mode instead of being reconstructed from a `Range`.
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

/**
 * An active select-mode range always wins over the browser's own selection: select mode exists
 * precisely to name a rectangle a linear selection cannot express, and its own pointerdown handler
 * already claims the gesture with `preventDefault()`, so there is usually no browser selection to
 * consult anyway. With no active range this serializes the whole table.
 */
function handleTableCopy(event) {
  if (!event.clipboardData) {
    return
  }
  const activeRange = getActiveTableSelection()
  const table = activeRange ? activeRange.table : tableForSelection(window.getSelection())
  if (!table) {
    return
  }
  const { html, text } = activeRange
    ? serializeTableRangeForClipboard(activeRange)
    : serializeTableForClipboard(table)
  event.clipboardData.setData('text/html', html)
  event.clipboardData.setData('text/plain', text)
  event.preventDefault()
}

/**
 * The guard flag lives on `root` itself, unlike every other pass here, which flags each element it
 * decorates: `v-html` replaces `root`'s children but never `root`, so a `copy` listener has to sit on
 * `root` to survive a re-render, and must therefore be attached exactly once for its lifetime.
 *
 * Delegated rather than per-table for the same reason: `copy` bubbles, so one listener on `root`
 * already sees every copy under it, including from a table rendered after this first ran.
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
    // -> Marks the block as done; the stylesheet also keys the button's position off this attribute
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
 * Appended to `.table-wrap`, the outer frame, and never to `.table-scroll`: the control must not
 * travel with the table's own horizontal scroll, nor be clipped by the scroller's `overflow-x`.
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
 * Built from the address bar rather than from the page store, so it carries whatever the reader is
 * actually on -- locale prefix included. The editor is the one place where those diverge: it previews a
 * page that lives at its own address, not at `/_edit/…`, so that prefix is dropped.
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
    // -> Declares that this control has a tooltip; `setLabel` keeps it in step with the label
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
  enableTableSelectMode(root)
}

/*
  CELL-RANGE SELECT MODE
  =============================================================

  An explicit, script-driven rectangular cell selection for a rendered table -- independent of the
  browser's own text selection, which is inherently linear (a start node/offset to an end one), not
  two-dimensional, and so can never express "this row/column rectangle" against a table laid out as
  CSS Grid `div`s (see `renderers/markdown.js`'s "TABLE GRID MARKUP" comment). The two corners are
  the "anchor" and the "focus", the same vocabulary a spreadsheet uses.

  State lives at module scope rather than closed over, so `getActiveTableSelection()` can expose the
  live rectangle to the copy handler.
*/

const TABLE_SELECT_CELL_SELECTOR = '[role="cell"], [role="columnheader"]'

/** Controls the content itself carries, whose own click a table-selection click must not steal -- the
 *  per-table copy button lives in the very `.table-wrap` a click here would otherwise land on. */
const TABLE_SELECT_INERT_SELECTOR = 'button, a, input, textarea, select, [contenteditable="true"]'

let activeSelection = null

let tableSelectDocumentListenersWired = false

/** `renderers/markdown.js` nests a row straight under the table itself, with no row-group wrapper, so
 *  a plain `:scope >` walk is the whole of what addressing a row needs. */
function tableSelectRows(table) {
  return Array.from(table.querySelectorAll(':scope > [role="row"]'))
}

function tableSelectCells(row) {
  return Array.from(row.querySelectorAll(':scope > [role="cell"], :scope > [role="columnheader"]'))
}

/**
 * Null when `cell` belongs to a table nested inside a cell's own content rather than to `table`
 * itself -- `closest()` resolves such a cell against its own nearest row and table.
 */
function tableSelectAddress(table, cell) {
  const row = cell.closest('[role="row"]')
  if (!row || row.parentElement !== table) {
    return null
  }
  const rowIndex = tableSelectRows(table).indexOf(row)
  const colIndex = tableSelectCells(row).indexOf(cell)
  if (rowIndex === -1 || colIndex === -1) {
    return null
  }
  return { row: rowIndex, col: colIndex }
}

function clampInt(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/** A roving `tabindex`: only the focused cell is ever tabbable, so a table is one tab stop. */
function focusTableSelectCell(cell) {
  if (activeSelection?.focusedCell && activeSelection.focusedCell !== cell) {
    activeSelection.focusedCell.removeAttribute('tabindex')
  }
  cell.setAttribute('tabindex', '0')
  cell.focus()
  if (activeSelection) {
    activeSelection.focusedCell = cell
  }
}

/** `data-table-selected` is the whole of what `_page-contents.css` needs to paint the highlight. */
function renderTableSelectHighlight() {
  if (!activeSelection) {
    return
  }
  const { table, anchorRow, anchorCol, focusRow, focusCol } = activeSelection
  const rowStart = Math.min(anchorRow, focusRow)
  const rowEnd = Math.max(anchorRow, focusRow)
  const colStart = Math.min(anchorCol, focusCol)
  const colEnd = Math.max(anchorCol, focusCol)

  for (const [rowIndex, row] of tableSelectRows(table).entries()) {
    const inRowRange = rowIndex >= rowStart && rowIndex <= rowEnd
    for (const [colIndex, cell] of tableSelectCells(row).entries()) {
      if (inRowRange && colIndex >= colStart && colIndex <= colEnd) {
        cell.dataset.tableSelected = ''
      } else {
        delete cell.dataset.tableSelected
      }
    }
  }

  syncNativeTableSelectionToRange(table, rowStart, colStart)
}

/**
 * Without SOME `Selection` touching the page, most browsers never raise a `copy` event at all on
 * Ctrl+C -- the platform's copy command is only enabled once something is selected, and select mode's
 * pointerdown handler `preventDefault()`s the browser's own selection away. Mirroring a real,
 * non-collapsed one onto the rectangle exists purely to make that event fire; `handleTableCopy` reads
 * `getActiveTableSelection()`, never this.
 *
 * `range.selectNode(cell)`, not `selectNodeContents(cell)`: the latter collapses to nothing on an
 * empty cell. Only the top-left corner, because a `Range` is linear (one DOM position to another), so
 * spanning corner to corner across rows would sweep in every cell in between in document order,
 * including ones outside the rectangle.
 *
 * Best-effort: the clipboard payload does not depend on it, and happy-dom does not reliably emulate
 * `Selection`/`Range`.
 */
function syncNativeTableSelectionToRange(table, rowIndex, colIndex) {
  try {
    const sel = window.getSelection?.()
    const cell = tableSelectCells(tableSelectRows(table)[rowIndex])[colIndex]
    if (!sel || !cell) {
      return
    }
    const range = document.createRange()
    range.selectNode(cell)
    sel.removeAllRanges()
    sel.addRange(range)
  } catch {
    // -> See the function comment: best-effort only.
  }
}

function clearTableSelection() {
  if (!activeSelection) {
    return
  }
  for (const cell of activeSelection.table.querySelectorAll('[data-table-selected]')) {
    delete cell.dataset.tableSelected
  }
  activeSelection.focusedCell?.removeAttribute('tabindex')
  activeSelection = null
  try {
    window.getSelection?.()?.removeAllRanges()
  } catch {
    // -> See syncNativeTableSelectionToRange's comment: best-effort only.
  }
}

/**
 * `cells` is the selected rectangle as rows of DOM elements in document order, already normalized so
 * it reads top-left to bottom-right regardless of which way the reader dragged.
 *
 * @returns {{ table: Element, rowStart: number, rowEnd: number, colStart: number, colEnd: number,
 *   cells: Element[][] } | null} null when nothing is currently selected.
 */
export function getActiveTableSelection() {
  if (!activeSelection) {
    return null
  }
  const { table, anchorRow, anchorCol, focusRow, focusCol } = activeSelection
  const rowStart = Math.min(anchorRow, focusRow)
  const rowEnd = Math.max(anchorRow, focusRow)
  const colStart = Math.min(anchorCol, focusCol)
  const colEnd = Math.max(anchorCol, focusCol)

  const rows = tableSelectRows(table)
  const cells = []
  for (let r = rowStart; r <= rowEnd; r++) {
    cells.push(tableSelectCells(rows[r]).slice(colStart, colEnd + 1))
  }
  return { table, rowStart, rowEnd, colStart, colEnd, cells }
}

/**
 * Deliberately NOT `helpers/pointerDrag.js`'s `trackPointerDrag`: that helper captures the pointer
 * onto one bounded surface so every subsequent event keeps targeting it, which is exactly backwards
 * here -- hit-testing WHICH cell the pointer is over is the entire point, and uncaptured
 * `pointermove` gets that from `event.target` for free. The accepted trade-off is that the gesture
 * stops updating once the pointer leaves the table's own content.
 */
function beginTableSelectDrag(table) {
  const onMove = (ev) => {
    if (!activeSelection || activeSelection.table !== table) {
      return
    }
    const cell = ev.target.closest?.(TABLE_SELECT_CELL_SELECTOR)
    if (!cell || !table.contains(cell)) {
      return
    }
    const addr = tableSelectAddress(table, cell)
    if (!addr) {
      return
    }
    activeSelection.focusRow = addr.row
    activeSelection.focusCol = addr.col
    renderTableSelectHighlight()
  }
  const onEnd = () => {
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onEnd)
    document.removeEventListener('pointercancel', onEnd)
  }
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onEnd, { once: true })
  document.addEventListener('pointercancel', onEnd, { once: true })
}

/**
 * Arrow keys only act while the event's own target sits inside the active selection's table, so one
 * typed anywhere else on the page -- a form field, a table tabbed away from -- is left alone.
 */
function handleTableSelectKeyDown(ev) {
  if (!activeSelection) {
    return
  }
  if (ev.key === 'Escape') {
    clearTableSelection()
    ev.preventDefault()
    return
  }

  const delta = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1]
  }[ev.key]
  if (!delta || !activeSelection.table.contains(ev.target)) {
    return
  }

  const { table } = activeSelection
  const rows = tableSelectRows(table)
  const row = clampInt(activeSelection.focusRow + delta[0], 0, rows.length - 1)
  const rowCells = tableSelectCells(rows[row])
  const col = clampInt(activeSelection.focusCol + delta[1], 0, Math.max(rowCells.length - 1, 0))

  activeSelection.focusRow = row
  activeSelection.focusCol = col
  if (!ev.shiftKey) {
    activeSelection.anchorRow = row
    activeSelection.anchorCol = col
  }
  renderTableSelectHighlight()
  focusTableSelectCell(rowCells[col])
  ev.preventDefault()
}

/**
 * A `pointerdown` the active selection's table does not contain ends it. For one that lands on a cell,
 * `handleTableSelectPointerDown` has already run earlier in the same bubble phase and replaced the
 * selection, so this sees the new table and leaves it alone.
 */
function handleTableSelectClickAway(ev) {
  if (activeSelection && !activeSelection.table.contains(ev.target)) {
    clearTableSelection()
  }
}

/**
 * Once for the page's whole lifetime, not once per `root`: only one selection is ever active however
 * many roots called `enableTableSelectMode`, so a second pair of document-level listeners would only
 * add no-op checks to every keystroke and click on the page.
 */
function ensureTableSelectDocumentListeners() {
  if (tableSelectDocumentListenersWired) {
    return
  }
  tableSelectDocumentListenersWired = true
  document.addEventListener('pointerdown', handleTableSelectClickAway)
  document.addEventListener('keydown', handleTableSelectKeyDown)
}

/**
 * Landing on content that is not a cell does nothing here -- `handleTableSelectClickAway`'s
 * document-level listener is what ends whatever was active in that case.
 */
function handleTableSelectPointerDown(root, ev) {
  if (ev.button !== 0 || ev.target.closest?.(TABLE_SELECT_INERT_SELECTOR)) {
    return
  }
  const cell = ev.target.closest?.(TABLE_SELECT_CELL_SELECTOR)
  const table = cell?.closest('[role="table"]')
  if (!cell || !table || !root.contains(table)) {
    return
  }
  const addr = tableSelectAddress(table, cell)
  if (!addr) {
    return
  }

  ensureTableSelectDocumentListeners()

  if (ev.shiftKey && activeSelection?.table === table) {
    activeSelection.focusRow = addr.row
    activeSelection.focusCol = addr.col
    renderTableSelectHighlight()
    focusTableSelectCell(cell)
    ev.preventDefault()
    return
  }

  if (activeSelection && activeSelection.table !== table) {
    clearTableSelection()
  }
  activeSelection = {
    table,
    anchorRow: addr.row,
    anchorCol: addr.col,
    focusRow: addr.row,
    focusCol: addr.col,
    focusedCell: null
  }
  renderTableSelectHighlight()
  focusTableSelectCell(cell)
  beginTableSelectDrag(table)
  ev.preventDefault()
}

/**
 * Delegated to `root` itself, so it survives `v-html` replacing the tables underneath it on every
 * re-render without needing to be re-wired.
 */
function enableTableSelectMode(root) {
  if (!root || root.dataset.tableSelect !== undefined) {
    return
  }
  root.dataset.tableSelect = ''
  root.addEventListener('pointerdown', (ev) => handleTableSelectPointerDown(root, ev))
}

/**
 * Test-only: module-scope state that a `document.body.innerHTML = ''` between tests does not itself
 * clear. The once-ever document listeners are left attached, harmlessly, like the rest of this
 * module's idempotent wiring.
 */
export function _resetTableSelectMode() {
  activeSelection = null
}

/*
  KEYWORD HIGHLIGHT / FIND
  =============================================================

  Carries a keyword forward from the knowledge graph's filter into the page the reader lands on;
  `Index.vue` layers find-like navigation (count, next/prev, auto-scroll) on the elements returned.

  A `TreeWalker` over the LIVE text nodes, deliberately not a string regex/replace against the HTML:
  splicing the string risks matching inside a tag attribute, a URL, or markup
  `enhanceRenderedContent` above already injected (a code-copy button's aria-label, the pilcrow).
  Walking the real DOM only ever sees text a reader can actually read.
*/

/** Marks these `<mark>` wrappers as this pass's own, distinct from an author's `==term==` markdown.
 *  `_page-contents.css` already styles a bare `mark`, which they reuse rather than inventing a second
 *  visual language; only the "current match" state adds anything. */
const KEYWORD_HIGHLIGHT_ATTR = 'keywordHighlight'
const KEYWORD_HIGHLIGHT_SELECTOR = 'mark[data-keyword-highlight]'

function skipsKeywordScan(parent) {
  return Boolean(parent?.closest(`script, style, ${KEYWORD_HIGHLIGHT_SELECTOR}`))
}

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
 * A plain `.indexOf` walk against lower-cased copies, not a `RegExp`: the term is arbitrary reader
 * input carried through a query param, and this way it is matched as the literal string it is, with
 * no regex-metacharacter escaping to get right.
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
 * Always clears any previous pass's wrappers first, so calling this again -- the same term after an
 * unrelated re-render, or a different term while the same content is still on screen -- never nests
 * one `<mark>` inside another. The `TreeWalker`'s already-wrapped-ancestor skip (`skipsKeywordScan`)
 * is the structural half of that: within one pass a match cannot be found twice, because
 * `collectHighlightableTextNodes` gathers its list before any mutation begins.
 *
 * @param {string} term A blank or whitespace-only term clears and finds nothing, same as no term.
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
 * The half of the decision `routableHref` and `sameDocumentHash` share: an anchor asking for a new
 * context (`target`, `download`, `rel="external"`) is the browser's to handle whatever it points at,
 * and an `href` that is not a URL at all is nobody's.
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
 * A page's HTML arrives through `v-html`, so every link in it is a plain anchor: left alone, the
 * browser tears the whole application down and builds it again to show a page the router could have
 * swapped in. Everything declined here stays exactly as the browser would have treated it.
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
  // -> A request for a file, not a page: the router's catch-all would render a page view over nothing
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
 * The counterpart to `routableHref`, which declines these: there is no page to load, only a place on
 * this one to travel to. Left to the browser it is an instant jump, where every other way of reaching
 * a heading in this app animates — the contents list does, and so does arriving with a `#heading` in
 * the URL.
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
