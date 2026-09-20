import { Position, Range } from 'monaco-editor'

/**
 * The markdown editor's insert commands -- everything its toolbar, its keybindings and its overlays
 * put into the document -- as plain functions over the Monaco editor they act on.
 *
 * Taking `editor` as an argument rather than closing over it is what makes each one testable on a
 * bare `monaco.editor.create()` with no component around it.
 *
 * The commands that are NOT here are the ones that are not about the editor at all: opening the file
 * manager or a picker overlay, asking the API which blocks a site has, raising a notification. Those
 * stay with the component, which is what owns the stores and dialogs they reach for.
 */

/**
 * The fence has to start a line of its own, so a cursor sitting mid-sentence breaks out of it first.
 */
export function insertCodeBlock(editor, language) {
  const model = editor.getModel()
  const selection = editor.getSelection()
  const selected = model.getValueInRange(selection)
  const startLine = model.getLineContent(selection.startLineNumber)
  const endLine = model.getLineContent(selection.endLineNumber)
  const before = startLine.slice(0, selection.startColumn - 1).trim().length > 0 ? '\n\n' : ''
  const after = endLine.slice(selection.endColumn - 1).trim().length > 0 ? '\n\n' : '\n'
  editor.executeEdits('', [
    {
      range: selection,
      text: `${before}\`\`\`${language}\n${selected}\n\`\`\`${after}`,
      forceMoveMarkers: true
    }
  ])
  if (!selected) {
    // -> Onto the empty line between the fences, which is the only place typing makes sense next
    const openerLine = selection.startLineNumber + (before ? 2 : 0)
    editor.setPosition({ lineNumber: openerLine + 1, column: 1 })
  }
  editor.focus()
}

/**
 * MDC's block syntax only opens a component when `::` starts a line, so a cursor mid-sentence breaks
 * out of it first.
 */
export function insertBlockClb(editor, markdown) {
  const position = editor.getPosition()
  const line = editor.getModel().getLineContent(position.lineNumber)
  const before = line.slice(0, position.column - 1).trim().length > 0 ? '\n\n' : ''
  const after = line.slice(position.column - 1).trim().length > 0 ? '\n\n' : '\n'
  insertAtCursor(editor, { content: `${before}${markdown}${after}` })
}

/**
 * A table only parses as one when its first row starts a line, so a new one breaks out of whatever
 * sentence the cursor sits in, and the blank line after separates it from what followed.
 *
 * An edited one replaces exactly the lines it occupied, so nothing around it moves and one undo takes
 * the whole table back. The cursor lands at the top of it rather than staying wherever it was, which may
 * be inside the text that was just replaced.
 */
export function insertTableClb(editor, { markdown, replace = null }) {
  const model = editor.getModel()
  if (replace) {
    editor.executeEdits('table', [
      {
        range: new Range(
          replace.startLine,
          1,
          replace.endLine,
          model.getLineMaxColumn(replace.endLine)
        ),
        text: markdown
      }
    ])
    editor.setPosition(new Position(replace.startLine, 1))
    editor.focus()
    return
  }
  const position = editor.getPosition()
  const line = model.getLineContent(position.lineNumber)
  const before = line.slice(0, position.column - 1).trim().length > 0 ? '\n\n' : ''
  const after = line.slice(position.column - 1).trim().length > 0 ? '\n\n' : '\n'
  insertAtCursor(editor, { content: `${before}${markdown}${after}` })
}

/**
 * Markdown numbers footnotes in the order they are referenced, not by their labels, so these are
 * names rather than positions — but an author reading the source expects them to count up, and two
 * notes sharing a name would collapse into one. Anything the author named themselves is left alone
 * and simply counted past.
 */
function nextFootnoteLabel(text) {
  let highest = 0
  for (const [, label] of text.matchAll(/\[\^([^\]\s]+)\]/g)) {
    if (/^\d+$/.test(label)) {
      highest = Math.max(highest, Number.parseInt(label, 10))
    }
  }
  return String(highest + 1)
}

/**
 * Both halves go in one `executeEdits` call, because either alone is broken — a marker with no note
 * renders as literal text, and a note nothing refers to renders as nothing at all — and one call is
 * one undo step, so a single Ctrl+Z removes both rather than leaving the other stranded.
 *
 * Both edit ranges come from the same pre-edit snapshot, so they collide when the cursor sits at the
 * document's end — which is exactly where this leaves it, and therefore where a repeated click with
 * no typing in between starts. Two edits at an identical range concatenate with no separation
 * (`[^1][^1]: `), so `cursorAtEnd` folds them into a single edit instead. The cursor ends on the
 * note, since writing it is what the author was about to do.
 */
export function insertFootnote(editor) {
  const model = editor.getModel()
  const label = nextFootnoteLabel(model.getValue())
  const cursor = editor.getPosition()
  const lastLine = model.getLineCount()
  const lastLineLength = model.getLineContent(lastLine).length
  const cursorAtEnd = cursor.lineNumber === lastLine && cursor.column === lastLineLength + 1

  const marker = `[^${label}]`
  /*
    -> One blank line clear of whatever the page ends with. With the cursor at that end, the marker
       itself is what the line will end with, so the gap is needed even if the line was empty.
  */
  const lead = cursorAtEnd || lastLineLength > 0 ? `\n\n` : ``
  const note = `${lead}[^${label}]: `

  editor.executeEdits(
    '',
    cursorAtEnd
      ? [
          {
            range: new Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column),
            text: `${marker}${note}`,
            forceMoveMarkers: true
          }
        ]
      : [
          {
            range: new Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column),
            text: marker,
            forceMoveMarkers: true
          },
          {
            range: new Range(lastLine, lastLineLength + 1, lastLine, lastLineLength + 1),
            text: note,
            forceMoveMarkers: true
          }
        ]
  )

  const noteLine = model.getLineCount()
  editor.setPosition({ lineNumber: noteLine, column: model.getLineContent(noteLine).length + 1 })
  editor.revealLineInCenterIfOutsideViewport(noteLine)
  editor.focus()
}

export function setHeaderLine(editor, lvl, focus = true) {
  const curLine = editor.getPosition().lineNumber
  let lineContent = editor.getModel().getLineContent(curLine)
  const lineLength = lineContent.length
  if (lineContent.startsWith('#')) {
    lineContent = lineContent.replace(/^(#+ )/, '')
  }
  lineContent = '#'.repeat(lvl) + ' ' + lineContent
  editor.executeEdits('', [
    {
      range: new Range(curLine, 1, curLine, lineLength + 1),
      text: lineContent,
      forceMoveMarkers: true
    }
  ])
  if (focus) {
    editor.focus()
  }
}

export function getHeaderLevel(editor) {
  const curLine = editor.getPosition().lineNumber
  const lineContent = editor.getModel().getLineContent(curLine)
  let lvl = 0
  const result = lineContent.match(/^(#+) /)
  if (result) {
    lvl = (result?.[1] ?? '').length
  }
  return lvl
}

export function insertAtCursor(editor, { content, focus = true }) {
  const cursor = editor.getPosition()
  editor.executeEdits('', [
    {
      range: new Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column),
      text: content,
      forceMoveMarkers: true
    }
  ])
  if (focus) {
    editor.focus()
  }
}

export function insertAfter(editor, { content, newLine, focus = true }) {
  const curLine = editor.getPosition().lineNumber
  const lineLength = editor.getModel().getLineContent(curLine).length
  editor.executeEdits('', [
    {
      range: new Range(curLine, lineLength + 1, curLine, lineLength + 1),
      text: newLine ? `\n\n${content}\n` : `\n${content}`,
      forceMoveMarkers: true
    }
  ])
  if (focus) {
    editor.focus()
    editor.revealLineInCenterIfOutsideViewport(editor.getPosition().lineNumber)
  }
}

const TASK_LIST_MARKER_RE = /^(\s*)-\s\[([ xX])\]\s/
const ORDERED_LIST_MARKER_RE = /^(\s*)(\d+)([.)])\s/
const UNORDERED_LIST_MARKER_RE = /^(\s*)([-*+])\s/

function detectListMarker(lineContent) {
  let match = lineContent.match(TASK_LIST_MARKER_RE)
  if (match) {
    return { type: 'task', indent: match[1], markerLength: match[0].length }
  }
  match = lineContent.match(ORDERED_LIST_MARKER_RE)
  if (match) {
    return {
      type: 'ordered',
      indent: match[1],
      markerLength: match[0].length,
      number: Number.parseInt(match[2], 10),
      delimiter: match[3]
    }
  }
  match = lineContent.match(UNORDERED_LIST_MARKER_RE)
  if (match) {
    return { type: 'unordered', indent: match[1], markerLength: match[0].length, bullet: match[2] }
  }
  return null
}

function nextMarkerText(detected) {
  switch (detected.type) {
    case 'task':
      return '- [ ] '
    case 'ordered':
      return `${detected.number + 1}${detected.delimiter} `
    default:
      return `${detected.bullet} `
  }
}

function fallbackToDefaultEnter(editor) {
  editor.trigger('keyboard', 'type', { text: '\n' })
}

export function continueList(editor) {
  const selections = editor.getSelections()
  if (selections.length !== 1 || !selections[0].isEmpty()) {
    fallbackToDefaultEnter(editor)
    return
  }

  const selection = selections[0]
  const line = selection.startLineNumber
  const column = selection.startColumn
  const lineContent = editor.getModel().getLineContent(line)
  const detected = detectListMarker(lineContent)

  // -> A regex match doesn't mean the CURSOR is past the marker -- Enter pressed ahead of or inside
  //    the marker itself isn't continuation. Without this guard the split below would duplicate the
  //    marker onto the line it pushes down.
  if (!detected || column < detected.markerLength + 1) {
    fallbackToDefaultEnter(editor)
    return
  }

  const remainder = lineContent.slice(detected.markerLength)

  if (remainder.length === 0) {
    const lineMaxColumn = editor.getModel().getLineMaxColumn(line)
    editor.executeEdits('cardinaljs.continueList', [
      { range: new Range(line, 1, line, lineMaxColumn), text: '', forceMoveMarkers: true }
    ])
    return
  }

  const marker = detected.indent + nextMarkerText(detected)
  editor.executeEdits('cardinaljs.continueList', [
    { range: new Range(line, column, line, column), text: `\n${marker}`, forceMoveMarkers: true }
  ])
}

/**
 * `before` is a line of its own, put above the first of them — the `> [!NOTE]` that opens an
 * admonition. It rides along in that line's own edit rather than as an insertion of its own, so no
 * two edits in the batch start at the same position.
 */
export function insertBeforeEachLine(editor, { content, before, focus = true }) {
  const edits = []
  for (const selection of editor.getSelections()) {
    const lineCount = selection.endLineNumber - selection.startLineNumber + 1
    const lines = Array.from({ length: lineCount }, (_, l) => l + selection.startLineNumber)
    for (const line of lines) {
      let lineContent = editor.getModel().getLineContent(line)
      const lineLength = lineContent.length
      if (lineContent.startsWith(content)) {
        lineContent = lineContent.substring(content.length)
      }
      const opening = before && line === lines[0] ? `${before}\n` : ''
      edits.push({
        range: new Range(line, 1, line, lineLength + 1),
        text: `${opening}${content}${lineContent}`,
        forceMoveMarkers: true
      })
    }
  }

  editor.executeEdits('', edits)

  if (focus) {
    editor.focus()
  }
}

export function insertHorizontalBar(editor) {
  insertAfter(editor, { content: '---', newLine: true })
}
