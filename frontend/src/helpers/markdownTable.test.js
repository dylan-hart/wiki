import { describe, expect, it } from 'vitest'

import { findEditableTables } from './markdownTable'

/**
 * `findEditableTables` is what the "Edit Table" CodeLens (`EditorMarkdown.vue`) draws its lenses
 * from -- the lens appears exactly where this says a table starts, and never over a table this
 * cannot hold (a multi-line cell, a `^^` rowspan, or a second MultiMarkdown body). See task 481
 * (Feature 364)'s manual pass: this is the automatable half of "the lens appears only over an
 * editable table" -- Monaco's own positioning of a lens given a range is not something a unit test
 * can usefully re-verify.
 */
describe('findEditableTables', () => {
  it('finds an ordinary table with a header row', () => {
    const source = '| A | B |\n| - | - |\n| 1 | 2 |'
    const [table] = findEditableTables(source)
    expect(table).toMatchObject({ startLine: 1, endLine: 3, source })
  })

  it('finds a headerless MultiMarkdown table (delimiter row first)', () => {
    const source = '| - | - |\n| 1 | 2 |'
    const [table] = findEditableTables(source)
    expect(table).toMatchObject({ startLine: 1, endLine: 2 })
  })

  it('includes a trailing markdown-it-attrs line ({.class}) as part of the table range', () => {
    const source = '| A | B |\n| - | - |\n| 1 | 2 |\n{.striped}'
    const [table] = findEditableTables(source)
    expect(table.endLine).toBe(4)
    expect(table.source).toContain('{.striped}')
  })

  it('excludes a table with a multi-line cell (a row ending in a continuation backslash)', () => {
    const source = '| A | B |\n| - | - |\n| this cell continues \\'
    expect(findEditableTables(source)).toEqual([])
  })

  it('excludes a table using a `^^` rowspan cell', () => {
    const source = '| A | B |\n| - | - |\n| 1 | 2 |\n| ^^ | 3 |'
    expect(findEditableTables(source)).toEqual([])
  })

  it('excludes a table with a second MultiMarkdown body (continues below a blank line)', () => {
    const source = '| A | B |\n| - | - |\n| 1 | 2 |\n\n| 3 | 4 |'
    expect(findEditableTables(source)).toEqual([])
  })

  it('does not treat a table inside a fenced code block as a table', () => {
    const source = '```\n| A | B |\n| - | - |\n| 1 | 2 |\n```'
    expect(findEditableTables(source)).toEqual([])
  })

  it('does not mistake a paragraph that merely contains a pipe for a table', () => {
    const source = 'This sentence has a | in it, but is not a table.'
    expect(findEditableTables(source)).toEqual([])
  })

  it('finds every table in the document, in order', () => {
    const source = '| A |\n| - |\n| 1 |\n\ntext between\n\n| B |\n| - |\n| 2 |'
    const tables = findEditableTables(source)
    expect(tables).toHaveLength(2)
    expect(tables[0].startLine).toBe(1)
    expect(tables[1].startLine).toBe(7)
  })
})
