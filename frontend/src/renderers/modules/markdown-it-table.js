/**
 * A purpose-built replacement for `markdown-it-multimd-table` (OpenProject #3110). That plugin has
 * had no release since Aug 2023 and calls a `md.utils.assign` helper markdown-it itself dropped in
 * v14 -- `.use()`-ing it at all used to require a process-wide `md.utils.assign ??= Object.assign`
 * shim just to keep the constructor from throwing. This module needs no shim: it is written directly
 * against markdown-it 15's own block-rule API (`state.push`, `token.attrSet`, `md.block.ruler`).
 *
 * Covers exactly the three MultiMarkdown table features `renderers/markdown.js` turns on
 * (`multiline`/`rowspan`/`headerless`, each individually toggleable via `options` though the caller
 * always enables all three) -- a plain pipe table with none of them is already handled by
 * markdown-it's own built-in `table` rule, which is why this plugin only runs at all when
 * `config.multimdTable` is on, and disables that built-in rule for the whole instance the moment it
 * does (see the constructor comment below): the two must never both try to claim the same lines.
 *
 * Syntax, in the order a table is read:
 *
 * - **A cell spanning several columns** is written as extra, otherwise-empty pipe cells immediately
 *   after the spanning one -- `| A |||` is one 3-column header row whose only real cell is "A". Every
 *   row in the table (header, separator, and every body row) must still declare the same NUMBER of
 *   pipe-delimited cells, empty placeholders included, so a later row's column position lines up with
 *   the header's regardless of how many of its neighbours it has swallowed.
 * - **A cell spanning several rows** is written as `^^` in the row below the one it extends -- the
 *   column position (not the rendered position, since colspan doesn't remove a placeholder's slot)
 *   is what ties it to the cell directly above. A `^^` may itself be followed by another `^^` one row
 *   further down, extending the same top cell again.
 * - **A cell continuing onto the next line** is signalled by an unescaped `\` as the very last
 *   character of an otherwise-finished row -- MultiMarkdown's own "this row isn't done yet" marker.
 *   It continues the WHOLE row, not one cell: every column's piece on the next physical line is
 *   appended to the SAME column's piece already read, joined by `\n`. A cell that ends up with an
 *   embedded newline this way renders as a real `<p>`, exactly as authoring two lines inside a real
 *   `<td>` would -- every other cell (the overwhelmingly common case) renders as bare inline content,
 *   with no paragraph wrapper, the same as markdown-it's own built-in table rule.
 * - **A table with no header row** is one whose very FIRST row is the separator (`---|---`) rather
 *   than a row of header text above it -- there is no ambiguity to resolve, since a separator row's
 *   own shape (only `-`, `:` and whitespace in every cell) never collides with real cell content.
 * - **A caption** is a single line reading `[Some text]` and nothing else, authored either
 *   immediately above the table's first line or immediately below its last row. It renders as
 *   `caption_open`/`inline`/`caption_close` in that same authored position -- naturally above the
 *   rows for a top caption, naturally after them for a bottom one -- rather than the old plugin's own
 *   quirk of always emitting it as the table's first child regardless of which end it was authored
 *   on. That was a limitation of the old plugin, not a shape `renderers/markdown.js`'s retagging (or
 *   `_page-contents.scss`'s `order: 1` rule for a bottom caption, keyed off the `caption-side: bottom`
 *   style this plugin still sets) actually needs: both already place a bottom caption at the visual
 *   end of the grid by CSS order, regardless of where its own tokens sit in the document.
 *
 * Token shape matches markdown-it's own built-in `table` rule exactly --
 * `table_open`/`thead_open`/`tr_open`/`th_open`/`td_open`/`tbody_open`/`table_close`, each with a
 * `.map` source line range -- so `renderers/markdown.js`'s CSS-Grid retagging rules (`table_open` ->
 * `<div role="table">`, `th_open`/`td_open` -> `<div role="columnheader"/"cell">`, the
 * `colspan`/`rowspan` -> `aria-colspan`/`aria-rowspan` rename, the `caption_open` -> `.table-caption`
 * rule) all apply unchanged, having no idea which rule produced the tokens underneath them.
 */

const CAPTION_RE = /^\[(.+)\]\s*$/
const SEPARATOR_CELL_RE = /^:?-+:?$/

/**
 * Splits a table row's already-fetched line text on unescaped `|` -- ported directly from
 * markdown-it's own built-in `table` rule (`escapedSplit`), since a cell containing a literal `\|`
 * (an escaped pipe, meant as content rather than a column boundary) has to keep working the same way
 * it always has for a plain pipe table.
 */
function escapedSplit(str) {
  const result = []
  const max = str.length
  let pos = 0
  let isEscaped = false
  let lastPos = 0
  let current = ''
  let ch = str.charCodeAt(pos)
  while (pos < max) {
    if (ch === 0x7c /* | */) {
      if (!isEscaped) {
        result.push(current + str.slice(lastPos, pos))
        current = ''
        lastPos = pos + 1
      } else {
        current += str.slice(lastPos, pos - 1)
        lastPos = pos
      }
    }
    isEscaped = ch === 0x5c /* \ */
    pos++
    ch = str.charCodeAt(pos)
  }
  result.push(current + str.slice(lastPos))
  return result
}

function getLine(state, line) {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
}

/**
 * One physical line's cells, trimmed -- a leading/trailing pipe (the normal, but optional, way to
 * bound a row) is dropped; an EMPTY middle cell is kept, since that is exactly what a colspan
 * placeholder looks like once split.
 */
function splitCells(text) {
  const fields = escapedSplit(text.trim())
  if (fields.length && fields[0] === '') {
    fields.shift()
  }
  if (fields.length && fields[fields.length - 1] === '') {
    fields.pop()
  }
  return fields.map((cell) => cell.trim())
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => SEPARATOR_CELL_RE.test(cell))
}

function alignsFor(cells) {
  return cells.map((cell) => {
    const leftColon = cell.startsWith(':')
    const rightColon = cell.endsWith(':')
    if (leftColon && rightColon) return 'center'
    if (rightColon) return 'right'
    if (leftColon) return 'left'
    return ''
  })
}

export default function markdownItTable(md, options = {}) {
  const multilineEnabled = options.multiline !== false
  const rowspanEnabled = options.rowspan !== false
  const headerlessEnabled = options.headerless !== false

  /*
    The built-in `table` rule and this one must never both try to own the same lines -- there is no
    scenario where a headered, non-spanning, single-line-cell table (the only shape the built-in rule
    understands) shouldn't ALSO be readable by this superset. Disabling it for the whole markdown-it
    instance is what `renderers/markdown.js`'s own `if (config.multimdTable)` branch already
    guarantees only happens when this plugin is actually `.use()`-d.
  */
  md.block.ruler.disable('table')

  /**
   * Whether `line` begins a valid table (headered or headerless), without consuming anything -- used
   * both for the real parse and, one line further ahead, to decide whether a `[Caption]` line is
   * genuinely a caption authored above a table or just a paragraph that happens to start with
   * brackets.
   */
  function detectTableShape(state, line, endLine) {
    if (line >= endLine) return null
    const firstText = getLine(state, line).trim()
    if (!firstText || firstText.indexOf('|') === -1) return null
    const firstCells = splitCells(firstText)
    if (!firstCells.length) return null

    if (isSeparatorRow(firstCells)) {
      if (!headerlessEnabled) return null
      return {
        headerless: true,
        headerLine: line,
        headerCells: null,
        colCount: firstCells.length,
        aligns: alignsFor(firstCells),
        bodyStart: line + 1
      }
    }

    const sepLine = line + 1
    if (sepLine >= endLine) return null
    const sepText = getLine(state, sepLine).trim()
    if (!sepText || sepText.indexOf('|') === -1) return null
    const sepCells = splitCells(sepText)
    if (!isSeparatorRow(sepCells) || sepCells.length !== firstCells.length) return null

    return {
      headerless: false,
      headerLine: line,
      headerCells: firstCells,
      colCount: firstCells.length,
      aligns: alignsFor(sepCells),
      bodyStart: sepLine + 1
    }
  }

  /**
   * One logical row starting at `line`, following a trailing, unescaped `\` onto as many following
   * physical lines as keep ending in one. Each physical line's cells are trimmed before being joined
   * with `\n`, so a genuinely continued cell never has stray trailing whitespace sitting in front of
   * the line break.
   */
  function readLogicalRow(state, line, endLine) {
    let merged = null
    let l = line
    for (;;) {
      if (l >= endLine) break
      const raw = getLine(state, l)
      const rTrimmed = raw.replace(/[ \t]+$/, '')
      const backslashRun = rTrimmed.match(/\\+$/)
      const willContinue = multilineEnabled && !!backslashRun && backslashRun[0].length % 2 === 1
      const text = willContinue ? rTrimmed.slice(0, -1) : raw
      const pieceCells = splitCells(text)

      if (!merged) {
        merged = pieceCells
      } else {
        for (let i = 0; i < merged.length; i++) {
          const piece = pieceCells[i]
          merged[i] = piece === undefined ? merged[i] : `${merged[i]}\n${piece}`
        }
      }

      l++
      if (!willContinue) break
    }
    return { cells: merged, nextLine: l }
  }

  function pushCellContent(state, content) {
    if (content.includes('\n')) {
      // -> A cell that grew from more than one physical line renders as a real paragraph, the same as
      //    authoring two lines inside a real `<td>` would -- see the module doc comment.
      state.push('paragraph_open', 'p', 1)
      const inline = state.push('inline', '', 0)
      inline.content = content
      inline.children = []
      state.push('paragraph_close', 'p', -1)
    } else {
      const inline = state.push('inline', '', 0)
      inline.content = content
      inline.children = []
    }
  }

  /**
   * Emits one row's `th_open`/`td_open` cells, resolving `|||`-style colspan placeholders and (for a
   * body row, when `previousColumnMap` is given) `^^` rowspan markers against it.
   *
   * @returns {Array} This row's own column map -- index `i` holds the `{ token, colspan, rowspan }`
   *          of whichever cell visually occupies column `i`, whether it was created in this row or
   *          inherited via `^^` -- for the NEXT row's own `^^` lookups to chain against.
   */
  function pushRow(state, cells, aligns, tag, colCount, previousColumnMap) {
    const columnMap = Array.from({ length: colCount }, () => null)
    let lastReal = null

    for (let i = 0; i < colCount; i++) {
      const raw = cells[i] ?? ''

      if (raw === '' && lastReal) {
        lastReal.colspan++
        lastReal.token.attrSet('colspan', String(lastReal.colspan))
        columnMap[i] = lastReal
        continue
      }

      if (rowspanEnabled && tag === 'td' && raw === '^^' && previousColumnMap?.[i]) {
        const target = previousColumnMap[i]
        target.rowspan++
        target.token.attrSet('rowspan', String(target.rowspan))
        columnMap[i] = target
        continue
      }

      const openToken = state.push(`${tag}_open`, tag, 1)
      if (aligns[i]) {
        openToken.attrSet('style', `text-align:${aligns[i]}`)
      }
      pushCellContent(state, raw)
      state.push(`${tag}_close`, tag, -1)

      const meta = { token: openToken, colspan: 1, rowspan: 1 }
      lastReal = meta
      columnMap[i] = meta
    }

    return columnMap
  }

  function pushCaption(state, text, isBottom) {
    const open = state.push('caption_open', 'caption', 1)
    if (isBottom) {
      open.attrSet('style', 'caption-side: bottom')
    }
    const inline = state.push('inline', '', 0)
    inline.content = text.trim()
    inline.children = []
    state.push('caption_close', 'caption', -1)
  }

  function multimdTableRule(state, startLine, endLine, silent) {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false

    let line = startLine
    let captionAbove = null

    const maybeCaption = getLine(state, line).trim().match(CAPTION_RE)
    if (maybeCaption && detectTableShape(state, line + 1, endLine)) {
      captionAbove = maybeCaption[1]
      line++
    }

    const shape = detectTableShape(state, line, endLine)
    if (!shape) return false

    if (silent) return true

    const oldParentType = state.parentType
    state.parentType = 'table'
    const terminatorRules = state.md.block.ruler.getRules('blockquote')

    const tableToken = state.push('table_open', 'table', 1)
    const tableMap = [startLine, 0]
    tableToken.map = tableMap

    if (captionAbove !== null) {
      pushCaption(state, captionAbove, false)
    }

    let previousColumnMap = null

    if (!shape.headerless) {
      const theadOpen = state.push('thead_open', 'thead', 1)
      theadOpen.map = [shape.headerLine, shape.headerLine + 1]
      const headerTr = state.push('tr_open', 'tr', 1)
      headerTr.map = [shape.headerLine, shape.headerLine + 1]
      previousColumnMap = pushRow(
        state,
        shape.headerCells,
        shape.aligns,
        'th',
        shape.colCount,
        null
      )
      state.push('tr_close', 'tr', -1)
      state.push('thead_close', 'thead', -1)
    }

    let nextLine = shape.bodyStart
    let bodyOpen = false
    let bodyMap = null

    while (nextLine < endLine) {
      if (state.sCount[nextLine] < state.blkIndent) break
      if (state.isEmpty(nextLine)) break

      let terminate = false
      for (let i = 0; i < terminatorRules.length; i++) {
        if (terminatorRules[i](state, nextLine, endLine, true)) {
          terminate = true
          break
        }
      }
      if (terminate) break

      const rowFirstText = getLine(state, nextLine).trim()
      if (!rowFirstText || rowFirstText.indexOf('|') === -1) break
      if (state.sCount[nextLine] - state.blkIndent >= 4) break

      const row = readLogicalRow(state, nextLine, endLine)

      if (!bodyOpen) {
        bodyOpen = true
        bodyMap = [nextLine, 0]
        state.push('tbody_open', 'tbody', 1).map = bodyMap
      }

      const rowTr = state.push('tr_open', 'tr', 1)
      rowTr.map = [nextLine, row.nextLine]
      previousColumnMap = pushRow(
        state,
        row.cells,
        shape.aligns,
        'td',
        shape.colCount,
        previousColumnMap
      )
      state.push('tr_close', 'tr', -1)

      nextLine = row.nextLine
    }

    if (bodyOpen) {
      state.push('tbody_close', 'tbody', -1)
      bodyMap[1] = nextLine
    }

    if (nextLine < endLine) {
      const trailing = getLine(state, nextLine).trim().match(CAPTION_RE)
      if (trailing) {
        pushCaption(state, trailing[1], true)
        nextLine++
      }
    }

    state.push('table_close', 'table', -1)
    tableMap[1] = nextLine

    state.parentType = oldParentType
    state.line = nextLine
    return true
  }

  md.block.ruler.before('table', 'multimd_table', multimdTableRule, {
    alt: ['paragraph', 'reference']
  })
}
