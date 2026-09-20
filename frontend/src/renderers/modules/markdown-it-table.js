/**
 * Replaces `markdown-it-multimd-table`, unmaintained and calling a `md.utils.assign` helper
 * markdown-it dropped in v14. Written against markdown-it 15's own block-rule API instead.
 *
 * MultiMarkdown table syntax, which the code alone does not spell out:
 *
 * - **colspan**: extra empty pipe cells after the spanning one (`| A |||`). Every row must still
 *   declare the same NUMBER of cells, placeholders included, so column positions line up.
 * - **rowspan**: `^^` in the row below, tied to the cell above by column position (not rendered
 *   position, since a colspan placeholder keeps its slot). Chains further down.
 * - **multiline**: an unescaped trailing `\` continues the WHOLE row, not one cell -- each column's
 *   piece on the next physical line is appended to the SAME column's, joined by `\n`. A cell that
 *   ends up with an embedded newline renders as a real `<p>`; every other cell stays bare inline
 *   content, as markdown-it's built-in rule does.
 * - **headerless**: the table's very first row is the separator.
 * - **caption**: a lone `[Some text]` line above or below the table, emitted in that authored
 *   position. `_page-contents.css` places a bottom caption visually last off the
 *   `caption-side: bottom` style set here, so token order need not match.
 *
 * Token shape matches markdown-it's built-in `table` rule exactly, so `renderers/markdown.js`'s
 * CSS-Grid retagging applies unchanged, unaware of which rule produced the tokens.
 */

const CAPTION_RE = /^\[(.+)\]\s*$/
const SEPARATOR_CELL_RE = /^:?-+:?$/

/**
 * Ported from markdown-it's own built-in `table` rule, so an escaped `\|` inside a cell keeps
 * behaving the way it does for a plain pipe table.
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
 * A leading/trailing pipe is dropped; an EMPTY middle cell is kept -- that is what a colspan
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
    The built-in `table` rule and this one must never both claim the same lines, and this rule is a
    superset of it. Disabling it instance-wide is safe because `renderers/markdown.js` only
    `.use()`s this plugin when `config.multimdTable` is on.
  */
  md.block.ruler.disable('table')

  /**
   * Consumes nothing, so a `[Caption]` line can be tested one line ahead against a real table
   * rather than being mistaken for a paragraph that merely starts with brackets.
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
   * Each physical line's cells are trimmed before being joined with `\n`, so a continued cell never
   * carries stray trailing whitespace in front of the line break.
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
   * @returns {Array} Column map: index `i` holds the `{ token, colspan, rowspan }` of whichever cell
   *          visually occupies column `i`, created here or inherited via `^^`, for the NEXT row's
   *          own `^^` lookups to chain against.
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
