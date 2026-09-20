import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetContentImageZoom } from './contentImageZoom'
import {
  _resetTableSelectMode,
  enhanceRenderedContent,
  getActiveTableSelection,
  routableHref,
  sameDocumentHash
} from './renderedContent'
import { queue as notifyQueue } from '@/composables/notify'

// A translation table standing in for `en.json`, keyed the same way a real `useI18n().t` would
// resolve them -- so the assertions prove `enhanceRenderedContent` threads its `t` argument through
// to notify() and the controls' labels, not just that some string appears.
const MESSAGES = {
  'common.clipboard.failure': 'Failed to copy to clipboard.',
  'common.renderedContent.copyCode': 'Copy code',
  'common.renderedContent.copyCodeDone': 'Copied',
  'common.renderedContent.copyHeadingLink': 'Copy link to this section',
  'common.renderedContent.copyHeadingLinkDone': 'Link copied',
  'common.renderedContent.copyTable': 'Copy table as CSV',
  'common.renderedContent.copyTableDone': 'Copied'
}
const t = (key) => MESSAGES[key] ?? key

function codeBlock(text) {
  const pre = document.createElement('pre')
  pre.className = 'codeblock'
  const code = document.createElement('code')
  code.textContent = text
  pre.appendChild(code)
  document.body.appendChild(pre)
  return pre
}

/** The exact shape `renderers/markdown.js`'s table overrides produce -- the code under test walks
 *  roles rather than tags, so the fixture has to match it. */
function tableWrap(rowsHtml) {
  const wrap = document.createElement('div')
  wrap.className = 'table-wrap'
  wrap.innerHTML = `<div class="table-scroll"><div role="table">${rowsHtml}</div></div>`
  document.body.appendChild(wrap)
  return wrap
}

function row(cells, { header = false } = {}) {
  const role = header ? 'columnheader' : 'cell'
  return `<div role="row">${cells.map((text) => `<div role="${role}">${text}</div>`).join('')}</div>`
}

function headingWithId(id) {
  const heading = document.createElement('h2')
  heading.id = id
  heading.textContent = 'A section'
  document.body.appendChild(heading)
  return heading
}

/**
 * A grid `rows` deep and `cols` wide, the first row a header. Cells are addressed by index rather
 * than coordinates: happy-dom has no layout engine to hit-test a real pointer against.
 */
function selectTable(rows, cols) {
  let html = row(
    Array.from({ length: cols }, (_c, col) => `H${col}`),
    { header: true }
  )
  for (let r = 0; r < rows - 1; r++) {
    html += row(Array.from({ length: cols }, (_c, col) => `r${r}c${col}`))
  }
  const wrap = tableWrap(html)
  return {
    wrap,
    table: wrap.querySelector('[role="table"]'),
    cell(r, c) {
      return wrap
        .querySelectorAll('[role="row"]')
        [r].querySelectorAll('[role="cell"], [role="columnheader"]')[c]
    }
  }
}

function pointerEvent(type, props) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    button: 0,
    ...props
  })
}

function dispatchCopy(root) {
  const clipboardData = { setData: vi.fn() }
  const event = new Event('copy', { bubbles: true, cancelable: true })
  event.clipboardData = clipboardData
  const prevented = !root.dispatchEvent(event)
  return { clipboardData, prevented }
}

describe('renderedContent clipboard localization', () => {
  beforeEach(() => {
    notifyQueue.length = 0
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('raises the localized failure message via the passed-in t() when the copy rejects', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    })

    const pre = codeBlock('console.log(1)')
    enhanceRenderedContent(pre.parentNode, t)

    const button = pre.querySelector('.code-copy')
    expect(button).not.toBeNull()

    button.click()
    // -> copyWithFeedback's catch runs after the rejected clipboard promise settles
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0].type).toBe('negative')
    expect(notifyQueue[0].message).toBe('Failed to copy to clipboard.')
    expect(notifyQueue[0].caption).toBe('denied')
  })

  it('raises nothing when the copy succeeds', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
    })

    const pre = codeBlock('console.log(1)')
    enhanceRenderedContent(pre.parentNode, t)

    pre.querySelector('.code-copy').click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(notifyQueue).toHaveLength(0)
  })

  it('is idempotent -- re-running over the same content adds no second button', () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn() } })

    const pre = codeBlock('console.log(1)')
    enhanceRenderedContent(pre.parentNode, t)
    enhanceRenderedContent(pre.parentNode, t)

    expect(pre.querySelectorAll('.code-copy')).toHaveLength(1)
  })
})

describe('renderedContent code-fence start number (#3588)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn() } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['30', '29'],
    ['2', '1'],
    ['1', '0'],
    ['0', '0']
  ])('turns data-line-start="%s" into --codeline-offset: %s', (start, offset) => {
    const pre = codeBlock('a\nb')
    pre.dataset.lineStart = start
    enhanceRenderedContent(pre.parentNode, t)

    expect(pre.style.getPropertyValue('--codeline-offset')).toBe(offset)
  })

  it.each(['abc', '-4', '3.5', '', '1234567890', '30; color: red'])(
    'sets no offset for a data-line-start of %j',
    (start) => {
      const pre = codeBlock('a\nb')
      pre.dataset.lineStart = start
      enhanceRenderedContent(pre.parentNode, t)

      expect(pre.style.getPropertyValue('--codeline-offset')).toBe('')
    }
  )

  it('sets no offset, and no style attribute, on a block without data-line-start', () => {
    const pre = codeBlock('a\nb')
    enhanceRenderedContent(pre.parentNode, t)

    expect(pre.hasAttribute('style')).toBe(false)
  })
})

describe('renderedContent accessible-name/tooltip localization (#2357)', () => {
  beforeEach(() => {
    notifyQueue.length = 0
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('labels the code-copy button via t() at creation, and via t() again once copied', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
    })

    const pre = codeBlock('console.log(1)')
    enhanceRenderedContent(pre.parentNode, t)

    const button = pre.querySelector('.code-copy')
    expect(button.getAttribute('aria-label')).toBe('Copy code')
    expect(button.dataset.tooltip).toBeUndefined()

    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(button.getAttribute('aria-label')).toBe('Copied')
  })

  it('labels the heading-anchor button (aria-label and tooltip) via t() at creation, and via t() again once copied', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
    })

    const heading = headingWithId('a-section')
    enhanceRenderedContent(heading.parentNode, t)

    const button = heading.querySelector('.heading-anchor')
    expect(button.getAttribute('aria-label')).toBe('Copy link to this section')
    expect(button.dataset.tooltip).toBe('Copy link to this section')

    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(button.getAttribute('aria-label')).toBe('Link copied')
    expect(button.dataset.tooltip).toBe('Link copied')
  })
})

/** `csvOf` is private, so its serialization is exercised through the button's clipboard write. */
describe('renderedContent table copy-to-CSV button (#2972)', () => {
  beforeEach(() => {
    notifyQueue.length = 0
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('adds a .table-copy button to a rendered table, marking the wrapper done', () => {
    const wrap = tableWrap(row(['A', 'B'], { header: true }) + row(['1', '2']))
    enhanceRenderedContent(wrap.parentNode, t)

    expect(wrap.dataset.tableCopy).toBe('')
    const button = wrap.querySelector('.table-copy')
    expect(button).not.toBeNull()
    // -> The frame, not the scroller: the control must not travel with the table's horizontal scroll
    expect(button.parentElement).toBe(wrap)
  })

  it('copies the table as plain CSV, without quoting fields that need none', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    const wrap = tableWrap(row(['Name', 'Count'], { header: true }) + row(['apples', '3']))
    enhanceRenderedContent(wrap.parentNode, t)

    wrap.querySelector('.table-copy').click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(writeText).toHaveBeenCalledWith('Name,Count\napples,3')
  })

  it('quotes a field containing a comma, a double quote, or an embedded newline', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    const wrap = tableWrap(
      row(['Item', 'Note'], { header: true }) +
        row(['Comma, here', 'plain']) +
        row(['Say &quot;hi&quot;', 'plain']) +
        row(['Multi', `line one${'\n'}line two`])
    )
    enhanceRenderedContent(wrap.parentNode, t)

    wrap.querySelector('.table-copy').click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(writeText).toHaveBeenCalledWith(
      ['Item,Note', '"Comma, here",plain', '"Say ""hi""",plain', 'Multi,"line one\nline two"'].join(
        '\n'
      )
    )
  })

  it('is idempotent -- re-running over the same content adds no second button', () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn() } })

    const wrap = tableWrap(row(['A']))
    enhanceRenderedContent(wrap.parentNode, t)
    enhanceRenderedContent(wrap.parentNode, t)

    expect(wrap.querySelectorAll('.table-copy')).toHaveLength(1)
  })

  it('labels the button via t() at creation, and via t() again once copied', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
    })

    const wrap = tableWrap(row(['A']))
    enhanceRenderedContent(wrap.parentNode, t)

    const button = wrap.querySelector('.table-copy')
    expect(button.getAttribute('aria-label')).toBe('Copy table as CSV')

    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(button.getAttribute('aria-label')).toBe('Copied')
  })

  it('raises the localized failure message via the passed-in t() when the copy rejects', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    })

    const wrap = tableWrap(row(['A']))
    enhanceRenderedContent(wrap.parentNode, t)

    wrap.querySelector('.table-copy').click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0].type).toBe('negative')
    expect(notifyQueue[0].caption).toBe('denied')
  })
})

/**
 * happy-dom's `Selection`/`ClipboardEvent` support isn't reliable enough to drive this end-to-end
 * (real selection-and-copy coverage is `markdown.test.js`'s real-Chromium describe instead), so
 * `window.getSelection` is stubbed with just enough shape for `tableForSelection` to read, and the
 * `copy` event carries a hand-built `clipboardData` stand-in.
 */
describe('renderedContent whole-table copy as real <table> HTML (#3238)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function stubSelectionOn(node) {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ commonAncestorContainer: node })
    })
  }

  it('sets a real <table> HTML string and a TSV plain-text fallback, and prevents the default copy', () => {
    const wrap = tableWrap(row(['Name', 'Count'], { header: true }) + row(['apples', '3']))
    enhanceRenderedContent(wrap.parentNode, t)

    stubSelectionOn(wrap.querySelector('[role="cell"]'))
    const { clipboardData, prevented } = dispatchCopy(wrap.parentNode)

    expect(prevented).toBe(true)
    expect(clipboardData.setData).toHaveBeenCalledWith(
      'text/html',
      '<table><tr><th>Name</th><th>Count</th></tr><tr><td>apples</td><td>3</td></tr></table>'
    )
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'Name\tCount\napples\t3')
  })

  it('translates aria-colspan/aria-rowspan back to real colspan/rowspan', () => {
    const wrap = tableWrap(
      '<div role="row"><div role="columnheader" aria-colspan="2">A</div></div>' + row(['B', 'C'])
    )
    enhanceRenderedContent(wrap.parentNode, t)

    stubSelectionOn(wrap.querySelector('[role="table"]'))
    const { clipboardData } = dispatchCopy(wrap.parentNode)

    expect(clipboardData.setData).toHaveBeenCalledWith(
      'text/html',
      '<table><tr><th colspan="2">A</th></tr><tr><td>B</td><td>C</td></tr></table>'
    )
  })

  it("keeps a cell's inner markup (e.g. a link) rather than flattening it to plain text", () => {
    const wrap = tableWrap('<div role="row"><div role="cell"><a href="/x">link</a></div></div>')
    enhanceRenderedContent(wrap.parentNode, t)

    stubSelectionOn(wrap.querySelector('[role="cell"]'))
    const { clipboardData } = dispatchCopy(wrap.parentNode)

    expect(clipboardData.setData).toHaveBeenCalledWith(
      'text/html',
      '<table><tr><td><a href="/x">link</a></td></tr></table>'
    )
  })

  it('carries a .table-caption child over as a real <caption>', () => {
    const wrap = tableWrap('<div class="table-caption">Cap</div>' + row(['A']))
    enhanceRenderedContent(wrap.parentNode, t)

    stubSelectionOn(wrap.querySelector('[role="table"]'))
    const { clipboardData } = dispatchCopy(wrap.parentNode)

    expect(clipboardData.setData).toHaveBeenCalledWith(
      'text/html',
      '<table><caption>Cap</caption><tr><td>A</td></tr></table>'
    )
  })

  it('collapses an embedded tab/newline in a cell to a single space in the TSV fallback', () => {
    const wrap = tableWrap(row([`line one${'\n'}line two`, 'a\tb']))
    enhanceRenderedContent(wrap.parentNode, t)

    stubSelectionOn(wrap.querySelector('[role="table"]'))
    const { clipboardData } = dispatchCopy(wrap.parentNode)

    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'line one line two\ta b')
  })

  it('falls through to the normal browser copy when the selection reaches outside the table', () => {
    const wrap = tableWrap(row(['A']))
    const outside = document.createElement('p')
    wrap.parentNode.appendChild(outside)
    enhanceRenderedContent(wrap.parentNode, t)

    // -> A common ancestor above the table, standing in for a selection spanning it and the paragraph
    stubSelectionOn(wrap.parentNode)
    const { clipboardData, prevented } = dispatchCopy(wrap.parentNode)

    expect(prevented).toBe(false)
    expect(clipboardData.setData).not.toHaveBeenCalled()
  })

  it('falls through when nothing is selected (collapsed selection)', () => {
    const wrap = tableWrap(row(['A']))
    enhanceRenderedContent(wrap.parentNode, t)

    vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: true, rangeCount: 0 })
    const { clipboardData, prevented } = dispatchCopy(wrap.parentNode)

    expect(prevented).toBe(false)
    expect(clipboardData.setData).not.toHaveBeenCalled()
  })

  it('is wired once -- re-running enhanceRenderedContent over the same root does not double-fire the handler', () => {
    const wrap = tableWrap(row(['A']))
    enhanceRenderedContent(wrap.parentNode, t)
    enhanceRenderedContent(wrap.parentNode, t)

    stubSelectionOn(wrap.querySelector('[role="table"]'))
    const { clipboardData } = dispatchCopy(wrap.parentNode)

    // -> A second listener would have called setData twice
    expect(clipboardData.setData.mock.calls.filter(([kind]) => kind === 'text/html')).toHaveLength(
      1
    )
  })
})

describe('renderedContent content-image click-to-zoom wiring (#3066)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    _resetContentImageZoom()
  })

  it('opens the lightbox when a rendered image is clicked', () => {
    const container = document.createElement('div')
    const img = document.createElement('img')
    img.src = 'https://example.com/diagram.png'
    container.appendChild(img)
    document.body.appendChild(container)

    enhanceRenderedContent(container, t)
    img.click()

    const box = document.querySelector('dialog.content-image-lightbox')
    expect(box).not.toBeNull()
    expect(box.open).toBe(true)
    expect(box.querySelector('img').src).toBe('https://example.com/diagram.png')
  })
})

describe('renderedContent cell-range select mode (#3239)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    _resetTableSelectMode()
  })

  it('starts a one-cell selection on click, highlighting and focusing that cell', () => {
    const { wrap, cell } = selectTable(3, 3)
    enhanceRenderedContent(wrap.parentNode, t)

    const target = cell(1, 1)
    target.dispatchEvent(pointerEvent('pointerdown'))

    const selection = getActiveTableSelection()
    expect(selection.rowStart).toBe(1)
    expect(selection.rowEnd).toBe(1)
    expect(selection.colStart).toBe(1)
    expect(selection.colEnd).toBe(1)
    expect(selection.cells).toEqual([[target]])
    expect(target.dataset.tableSelected).toBe('')
    expect(document.activeElement).toBe(target)
    expect(target.getAttribute('tabindex')).toBe('0')
    expect(wrap.querySelectorAll('[data-table-selected]')).toHaveLength(1)
  })

  it('extends the range to the rectangle between anchor and focus while dragging', () => {
    const { wrap, cell } = selectTable(3, 3)
    enhanceRenderedContent(wrap.parentNode, t)

    cell(0, 1).dispatchEvent(pointerEvent('pointerdown'))
    cell(1, 1).dispatchEvent(pointerEvent('pointermove'))
    cell(2, 2).dispatchEvent(pointerEvent('pointermove'))

    const selection = getActiveTableSelection()
    expect(selection.rowStart).toBe(0)
    expect(selection.rowEnd).toBe(2)
    expect(selection.colStart).toBe(1)
    expect(selection.colEnd).toBe(2)
    // -> The rectangle, not just its two corners
    expect(wrap.querySelectorAll('[data-table-selected]')).toHaveLength(6)
    expect(cell(0, 0).dataset.tableSelected).toBeUndefined()
    expect(cell(1, 2).dataset.tableSelected).toBe('')
  })

  it('stops updating once pointerup ends the drag', () => {
    const { wrap, cell } = selectTable(3, 3)
    enhanceRenderedContent(wrap.parentNode, t)

    cell(0, 0).dispatchEvent(pointerEvent('pointerdown'))
    cell(1, 1).dispatchEvent(pointerEvent('pointermove'))
    document.dispatchEvent(pointerEvent('pointerup'))
    cell(2, 2).dispatchEvent(pointerEvent('pointermove'))

    const selection = getActiveTableSelection()
    expect(selection.rowEnd).toBe(1)
    expect(selection.colEnd).toBe(1)
  })

  it('extends the same table’s active selection on a shift-click, without a drag', () => {
    const { wrap, cell } = selectTable(3, 3)
    enhanceRenderedContent(wrap.parentNode, t)

    cell(0, 0).dispatchEvent(pointerEvent('pointerdown'))
    cell(2, 2).dispatchEvent(pointerEvent('pointerdown', { shiftKey: true }))

    const selection = getActiveTableSelection()
    expect(selection.rowStart).toBe(0)
    expect(selection.rowEnd).toBe(2)
    expect(selection.colStart).toBe(0)
    expect(selection.colEnd).toBe(2)
  })

  it('a plain click (no shift) on a new cell resets to a single-cell selection, anchor included', () => {
    const { wrap, cell } = selectTable(3, 3)
    enhanceRenderedContent(wrap.parentNode, t)

    cell(0, 0).dispatchEvent(pointerEvent('pointerdown'))
    cell(2, 2).dispatchEvent(pointerEvent('pointerdown', { shiftKey: true }))
    cell(1, 1).dispatchEvent(pointerEvent('pointerdown'))

    const selection = getActiveTableSelection()
    expect(selection.rowStart).toBe(1)
    expect(selection.rowEnd).toBe(1)
    expect(selection.colStart).toBe(1)
    expect(selection.colEnd).toBe(1)
  })

  it('Escape clears the selection and its roving tabindex', () => {
    const { wrap, cell } = selectTable(2, 2)
    enhanceRenderedContent(wrap.parentNode, t)

    const target = cell(0, 0)
    target.dispatchEvent(pointerEvent('pointerdown'))
    expect(getActiveTableSelection()).not.toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(getActiveTableSelection()).toBeNull()
    expect(wrap.querySelectorAll('[data-table-selected]')).toHaveLength(0)
    expect(target.hasAttribute('tabindex')).toBe(false)
  })

  it('a pointerdown outside the active table clears the selection (click-away)', () => {
    const { wrap, cell } = selectTable(2, 2)
    const elsewhere = document.createElement('p')
    document.body.appendChild(elsewhere)
    enhanceRenderedContent(wrap.parentNode, t)

    cell(0, 0).dispatchEvent(pointerEvent('pointerdown'))
    expect(getActiveTableSelection()).not.toBeNull()

    elsewhere.dispatchEvent(pointerEvent('pointerdown'))

    expect(getActiveTableSelection()).toBeNull()
  })

  it('clicking into a second table clears the first table’s selection before starting the new one', () => {
    const first = selectTable(2, 2)
    const second = selectTable(2, 2)
    enhanceRenderedContent(document.body, t)

    first.cell(0, 0).dispatchEvent(pointerEvent('pointerdown'))
    second.cell(1, 1).dispatchEvent(pointerEvent('pointerdown'))

    expect(first.wrap.querySelectorAll('[data-table-selected]')).toHaveLength(0)
    expect(getActiveTableSelection().table).toBe(second.table)
  })

  it('does not steal a click on the per-table copy button (#3238’s control)', () => {
    const { wrap } = selectTable(2, 2)
    enhanceRenderedContent(wrap.parentNode, t)

    wrap.querySelector('.table-copy').dispatchEvent(pointerEvent('pointerdown'))

    expect(getActiveTableSelection()).toBeNull()
  })

  it('arrow keys move the focus cell, and shift extends the range instead of moving the anchor', () => {
    const { wrap, cell } = selectTable(3, 3)
    enhanceRenderedContent(wrap.parentNode, t)

    cell(1, 1).dispatchEvent(pointerEvent('pointerdown'))

    cell(1, 1).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    let selection = getActiveTableSelection()
    expect(selection.rowStart).toBe(2)
    expect(selection.rowEnd).toBe(2)
    expect(document.activeElement).toBe(cell(2, 1))

    cell(2, 1).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })
    )
    selection = getActiveTableSelection()
    expect(selection.rowStart).toBe(2)
    expect(selection.rowEnd).toBe(2)
    expect(selection.colStart).toBe(1)
    expect(selection.colEnd).toBe(2)
  })

  it('clamps arrow-key navigation at the grid edge rather than moving off it', () => {
    const { wrap, cell } = selectTable(2, 2)
    enhanceRenderedContent(wrap.parentNode, t)

    cell(0, 0).dispatchEvent(pointerEvent('pointerdown'))
    cell(0, 0).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    cell(0, 0).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))

    const selection = getActiveTableSelection()
    expect(selection.rowStart).toBe(0)
    expect(selection.colStart).toBe(0)
  })

  it('leaves an arrow key typed outside the active table alone', () => {
    const { wrap, cell } = selectTable(2, 2)
    const input = document.createElement('input')
    document.body.appendChild(input)
    enhanceRenderedContent(wrap.parentNode, t)

    cell(0, 0).dispatchEvent(pointerEvent('pointerdown'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))

    const selection = getActiveTableSelection()
    expect(selection.rowStart).toBe(0)
  })

  it('is idempotent -- re-running enhanceRenderedContent over the same root wires no second pointerdown listener', () => {
    // -> A fresh, never-enhanced root, not `document.body`: every other test here shares that via
    //    `tableWrap`, and an earlier one has already wired it, so a count against it proves nothing
    const container = document.createElement('div')
    document.body.appendChild(container)
    const addSpy = vi.spyOn(container, 'addEventListener')

    enhanceRenderedContent(container, t)
    enhanceRenderedContent(container, t)

    expect(addSpy.mock.calls.filter(([type]) => type === 'pointerdown')).toHaveLength(1)
    addSpy.mockRestore()
  })

  it('returns null with nothing selected', () => {
    expect(getActiveTableSelection()).toBeNull()
  })
})

describe('renderedContent cell-range copy (#3240)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    _resetTableSelectMode()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('copies only the active rectangle as <table> HTML + TSV, not the whole table', () => {
    const { wrap, cell } = selectTable(3, 3)
    enhanceRenderedContent(wrap.parentNode, t)

    // -> Rectangle: rows 0-1, cols 1-2 -- a proper subset of the 3x3 grid
    cell(0, 1).dispatchEvent(pointerEvent('pointerdown'))
    cell(1, 2).dispatchEvent(pointerEvent('pointerdown', { shiftKey: true }))

    const { clipboardData, prevented } = dispatchCopy(wrap.parentNode)

    expect(prevented).toBe(true)
    expect(clipboardData.setData).toHaveBeenCalledWith(
      'text/html',
      '<table>' +
        `<tr><th>${cell(0, 1).textContent}</th><th>${cell(0, 2).textContent}</th></tr>` +
        `<tr><td>${cell(1, 1).textContent}</td><td>${cell(1, 2).textContent}</td></tr>` +
        '</table>'
    )
    expect(clipboardData.setData).toHaveBeenCalledWith(
      'text/plain',
      `${cell(0, 1).textContent}\t${cell(0, 2).textContent}\n${cell(1, 1).textContent}\t${cell(1, 2).textContent}`
    )
    expect(clipboardData.setData.mock.calls.flatMap(([, value]) => value).join('\n')).not.toContain(
      cell(0, 0).textContent
    )
  })

  it('translates aria-colspan/aria-rowspan the same way the whole-table path does', () => {
    const wrap = tableWrap(
      '<div role="row"><div role="columnheader" aria-colspan="2">A</div></div>' + row(['B', 'C'])
    )
    enhanceRenderedContent(wrap.parentNode, t)

    const header = wrap.querySelector('[role="columnheader"]')
    header.dispatchEvent(pointerEvent('pointerdown'))

    const { clipboardData } = dispatchCopy(wrap.parentNode)

    expect(clipboardData.setData).toHaveBeenCalledWith(
      'text/html',
      '<table><tr><th colspan="2">A</th></tr></table>'
    )
  })

  it("keeps a selected cell's inner markup (e.g. a link) rather than flattening it to plain text", () => {
    const wrap = tableWrap('<div role="row"><div role="cell"><a href="/x">link</a></div></div>')
    enhanceRenderedContent(wrap.parentNode, t)

    wrap.querySelector('[role="cell"]').dispatchEvent(pointerEvent('pointerdown'))
    const { clipboardData } = dispatchCopy(wrap.parentNode)

    expect(clipboardData.setData).toHaveBeenCalledWith(
      'text/html',
      '<table><tr><td><a href="/x">link</a></td></tr></table>'
    )
  })

  it('collapses an embedded tab/newline in a selected cell to a single space in the TSV fallback', () => {
    const wrap = tableWrap(row([`line one${'\n'}line two`]))
    enhanceRenderedContent(wrap.parentNode, t)

    wrap.querySelector('[role="cell"]').dispatchEvent(pointerEvent('pointerdown'))
    const { clipboardData } = dispatchCopy(wrap.parentNode)

    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'line one line two')
  })

  it('never carries a .table-caption into a range copy, unlike the whole-table path', () => {
    const wrap = tableWrap('<div class="table-caption">Cap</div>' + row(['A']))
    enhanceRenderedContent(wrap.parentNode, t)

    wrap.querySelector('[role="cell"]').dispatchEvent(pointerEvent('pointerdown'))
    const { clipboardData } = dispatchCopy(wrap.parentNode)

    expect(clipboardData.setData).toHaveBeenCalledWith(
      'text/html',
      '<table><tr><td>A</td></tr></table>'
    )
  })

  it('falls back to whole-table copy when no select-mode range is active', () => {
    const { wrap } = selectTable(2, 2)
    enhanceRenderedContent(wrap.parentNode, t)
    expect(getActiveTableSelection()).toBeNull()

    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ commonAncestorContainer: wrap.querySelector('[role="table"]') })
    })
    const { clipboardData } = dispatchCopy(wrap.parentNode)

    // -> More than one row -- proof this went through the whole-table path, not a single-cell range
    expect(clipboardData.setData).toHaveBeenCalledWith(
      'text/html',
      expect.stringContaining('</tr><tr>')
    )
  })

  it('never reads the browser selection at all once a select-mode range is active', () => {
    const { wrap } = selectTable(2, 2)
    enhanceRenderedContent(wrap.parentNode, t)

    wrap.querySelector('[role="cell"]').dispatchEvent(pointerEvent('pointerdown'))

    // -> Spied only after the pointerdown settles, so `syncNativeTableSelectionToRange`'s own read
    //    isn't counted
    const getSelectionSpy = vi.spyOn(window, 'getSelection')
    dispatchCopy(wrap.parentNode)

    expect(getSelectionSpy).not.toHaveBeenCalled()
  })
})

describe('routableHref / sameDocumentHash (unchanged by #1597, smoke-tested alongside the file)', () => {
  const current = { origin: 'https://wiki.example.com', pathname: '/en/home' }

  it('routes a same-origin link to a different page', () => {
    expect(routableHref({ href: 'https://wiki.example.com/en/other' }, current)).toBe('/en/other')
  })

  it('declines a cross-origin link', () => {
    expect(routableHref({ href: 'https://elsewhere.example.com/en/other' }, current)).toBeNull()
  })

  it('resolves a same-page fragment as a hash to scroll to, not a route', () => {
    expect(routableHref({ href: 'https://wiki.example.com/en/home#section' }, current)).toBeNull()
    expect(sameDocumentHash({ href: 'https://wiki.example.com/en/home#section' }, current)).toBe(
      '#section'
    )
  })
})
