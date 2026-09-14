import { BUNDLED_ICONS } from '@/assets/icons.generated'

import { copyToClipboard } from './clipboard'
import { enhanceContentImageZoom } from './contentImageZoom'
import { isServerPath } from './serverPaths'
import { notify } from '@/composables/notify'

/**
 * The affordances a rendered page grows once it is on screen: a copy button on every code block, a
 * pilcrow on every heading that copies a link to it, and (OpenProject #3239) an explicit cell-range
 * select mode on every table.
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
  addHeadingAnchors(root, t)
  enhanceContentImageZoom(root, t)
  enableTableSelectMode(root)
}

/*
  CELL-RANGE SELECT MODE (OpenProject #3239, Feature #3143)
  =============================================================

  An explicit, script-driven rectangular cell selection for a rendered table -- independent of the
  browser's own text selection, which is inherently linear (a start node/offset to an end one), not
  two-dimensional, and so can never actually express "this row/column rectangle" against a table laid
  out as CSS Grid `div`s (see `renderers/markdown.js`'s "TABLE GRID MARKUP" comment). Click a cell to
  start a one-cell range; drag, or shift-click a second cell in the same table, extends it to the
  rectangle between the two (the "anchor" and the "focus" corner, the same vocabulary a spreadsheet
  uses). Escape, or a pointerdown that lands outside the active table entirely, ends it. Arrow keys
  move the focus corner one cell at a time once a cell has keyboard focus; shift held extends the
  range instead of moving the anchor along with it.

  State lives at module scope, not closed over anywhere unreachable from outside this file:
  `getActiveTableSelection()` is the read surface OpenProject #3240 (wiring this into the copy
  handler) needs next round.
*/

/** Matches a cell OR a header cell -- the two roles `renderers/markdown.js` gives a table's grid
 *  children (see the module comment above). */
const TABLE_SELECT_CELL_SELECTOR = '[role="cell"], [role="columnheader"]'

/** A control the content itself already carries, whose own click a table-selection click must not
 *  steal -- OpenProject #3238's per-table copy button lives in the very `.table-wrap` a click here
 *  would otherwise be free to land on, and a link/input/contenteditable region has its own job to do. */
const TABLE_SELECT_INERT_SELECTOR = 'button, a, input, textarea, select, [contenteditable="true"]'

/** The live selection (`{ table, anchorRow, anchorCol, focusRow, focusCol, focusedCell }`), or null
 *  when nothing is selected anywhere on the page -- there is only ever one at a time. */
let activeSelection = null

/** Whether the click-away/Escape listeners below have been wired yet -- once ever, not once per
 *  `root`; see `ensureTableSelectDocumentListeners`. */
let tableSelectDocumentListenersWired = false

/** Every `[role="row"]` directly under `table`, in document order -- `renderers/markdown.js` always
 *  nests a row straight under the table itself, with no row-group wrapper (see its own "TABLE GRID
 *  MARKUP" comment), so a plain `:scope >` walk is the whole of what addressing a row needs. */
function tableSelectRows(table) {
  return Array.from(table.querySelectorAll(':scope > [role="row"]'))
}

/** Every cell/columnheader directly under `row`, in document order. */
function tableSelectCells(row) {
  return Array.from(row.querySelectorAll(':scope > [role="cell"], :scope > [role="columnheader"]'))
}

/**
 * `{ row, col }` of `cell` inside `table`'s own grid, or null when `cell` does not actually belong to
 * it (a nested table inside a cell's own content resolves against ITS OWN nearest row/table instead,
 * which is what the `closest()` calls below naturally do).
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

/** Moves the roving `tabindex` (and real keyboard focus) onto `cell`, off whatever held it before. */
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

/**
 * Stamps `data-table-selected` on exactly the cells inside the active anchor<->focus rectangle, and
 * clears it from every other cell of the same table -- the whole of what `_page-contents.scss` needs
 * to paint the highlight.
 */
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
}

/** Ends the active selection, if there is one: clears its markers and its roving `tabindex`. */
function clearTableSelection() {
  if (!activeSelection) {
    return
  }
  for (const cell of activeSelection.table.querySelectorAll('[data-table-selected]')) {
    delete cell.dataset.tableSelected
  }
  activeSelection.focusedCell?.removeAttribute('tabindex')
  activeSelection = null
}

/**
 * The active cell-range selection, for a caller outside this module (OpenProject #3240's copy
 * handler) to read. `cells` is the selected rectangle as rows of DOM elements, in document order --
 * the shape a `<table>`-HTML/TSV serializer wants, and already clipped to whichever corner is
 * actually the top-left/bottom-right regardless of which way the reader dragged.
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
 * Tracks the rest of one drag gesture that started on `table`: every `pointermove` landing on one of
 * its own cells extends the focus corner there.
 *
 * Deliberately NOT `helpers/pointerDrag.js`'s `trackPointerDrag` -- that helper captures the pointer
 * onto one bounded surface (`WColorPicker`'s field, `WRange`'s rail) precisely so every subsequent
 * event keeps targeting it regardless of where the pointer physically is, which is exactly backwards
 * for this: hit-testing WHICH cell the pointer is over is the entire point. Plain, uncaptured
 * `pointermove` listeners get that hit-test for free from `event.target` -- a real browser resolves it
 * the normal way, and a test can dispatch straight at a target cell with no layout engine required.
 * The trade-off is that the gesture stops updating once the pointer leaves the table's own content
 * (there is no capture keeping events aimed at it), an accepted limitation for a simpler, directly
 * testable path.
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
 * Escape (ends the selection outright), or an arrow key moving the focus corner one cell at a time --
 * shift held extends the range instead of dragging the anchor along with it. Arrow keys only act while
 * the event's own target sits inside the active selection's table, so an arrow key typed anywhere else
 * on the page (a form field, a different table entered and then tabbed away from) is left alone.
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
 * The click-away half of entry/exit: a `pointerdown` anywhere the active selection's own table does
 * not contain ends it, regardless of whether that landed inside some OTHER enhanced root's content, a
 * completely unrelated part of the page, or (via `handleTableSelectPointerDown` running first, in the
 * same bubble phase, for a pointerdown that lands on a cell) has already been superseded by a brand
 * new selection.
 */
function handleTableSelectClickAway(ev) {
  if (activeSelection && !activeSelection.table.contains(ev.target)) {
    clearTableSelection()
  }
}

/**
 * Wires the click-away/Escape listeners exactly once for the page's whole lifetime, not once per
 * `root` -- there is only ever one selection active at a time regardless of how many roots have
 * called `enableTableSelectMode`, so one shared pair of document-level listeners is enough, and
 * wiring more would just mean redundant no-op checks on every keystroke/click elsewhere on the page.
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
 * Click (or the first `pointerdown` of a drag) on a cell inside `root`: starts a new one-cell
 * selection, extends the active one (shift held, same table), or switches to a different table
 * entirely (clearing the old one's markers first, so nothing stale survives). Landing on content that
 * is not a cell at all does nothing here -- `handleTableSelectClickAway`'s own document-level listener
 * is what ends whatever was active in that case.
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
 * Wires cell-range select mode onto every table under `root`, once -- delegated to `root` itself
 * (idempotent via a dataset flag, the same convention every other pass in this file uses), so it
 * survives `v-html` replacing the tables underneath it on every re-render without needing to be
 * re-wired.
 *
 * @param {HTMLElement|null} root The element the render was written into.
 */
function enableTableSelectMode(root) {
  if (!root || root.dataset.tableSelect !== undefined) {
    return
  }
  root.dataset.tableSelect = ''
  root.addEventListener('pointerdown', (ev) => handleTableSelectPointerDown(root, ev))
}

/**
 * Test-only reset: clears whatever selection is currently active, without touching the
 * once-ever-wired document listeners (harmless left attached, same as the rest of this module's
 * idempotent wiring) or any root's own dataset flag. Mirrors `contentImageZoom.js`'s
 * `_resetContentImageZoom` -- module state a `document.body.innerHTML = ''` between tests does not
 * itself clear, since the selection lives at module scope precisely so #3240 can reach it.
 */
export function _resetTableSelectMode() {
  activeSelection = null
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
