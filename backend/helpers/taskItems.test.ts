import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseTaskItems, setTaskItem } from './taskItems.ts'

describe('parseTaskItems', () => {
  test('lists items in document order with their state and source line', () => {
    const items = parseTaskItems('# Todo\n\n- [ ] one\n- [x] two\n- [X] three\n- plain\n')
    assert.deepEqual(items, [
      { index: 0, text: 'one', checked: false, line: 2 },
      { index: 1, text: 'two', checked: true, line: 3 },
      { index: 2, text: 'three', checked: true, line: 4 }
    ])
  })

  test('counts nested, ordered and blockquoted items in document order', () => {
    const items = parseTaskItems('- [ ] a\n  - [x] b\n1. [ ] c\n\n> - [ ] d\n')
    assert.deepEqual(
      items.map((item) => [item.index, item.text, item.checked]),
      [
        [0, 'a', false],
        [1, 'b', true],
        [2, 'c', false],
        [3, 'd', false]
      ]
    )
  })

  test('ignores task markers inside fenced and indented code', () => {
    const markdown = '```md\n- [ ] in a fence\n```\n\n    - [ ] indented code\n\n- [ ] real\n'
    assert.deepEqual(
      parseTaskItems(markdown).map((item) => item.text),
      ['real']
    )
  })

  test('ignores a marker that is not followed by a space or text', () => {
    assert.deepEqual(parseTaskItems('- [ ]\n- [] none\n- [y] none\n- [ ]x\n'), [])
  })

  test('reads a loose item', () => {
    const items = parseTaskItems('- [ ] first\n\n- [x] second\n')
    assert.deepEqual(
      items.map((item) => item.checked),
      [false, true]
    )
  })
})

describe('setTaskItem', () => {
  test('ticks exactly one marker', () => {
    const markdown = '- [ ] one\n- [ ] two\n- [ ] three\n'
    assert.equal(setTaskItem(markdown, 1, 'two', true), '- [ ] one\n- [x] two\n- [ ] three\n')
  })

  test('unticks a checked item, including an uppercase X', () => {
    assert.equal(setTaskItem('- [X] one\n', 0, 'one', false), '- [ ] one\n')
  })

  test('leaves a task inside a fenced block untouched and targets the real item', () => {
    const markdown = '```\n- [ ] fenced\n```\n\n- [ ] real\n'
    assert.equal(setTaskItem(markdown, 0, 'real', true), '```\n- [ ] fenced\n```\n\n- [x] real\n')
    assert.equal(setTaskItem(markdown, 0, 'fenced', true), null)
    assert.equal(setTaskItem(markdown, 1, 'real', true), null)
  })

  test('rewrites nested, ordered and blockquoted markers in place', () => {
    const markdown = '- [ ] a\n  - [ ] b\n1. [ ] c\n> - [ ] d\n'
    assert.equal(setTaskItem(markdown, 1, 'b', true), '- [ ] a\n  - [x] b\n1. [ ] c\n> - [ ] d\n')
    assert.equal(setTaskItem(markdown, 2, 'c', true), '- [ ] a\n  - [ ] b\n1. [x] c\n> - [ ] d\n')
    assert.equal(setTaskItem(markdown, 3, 'd', true), '- [ ] a\n  - [ ] b\n1. [ ] c\n> - [x] d\n')
  })

  test('keeps the rest of the line and the line endings', () => {
    assert.equal(
      setTaskItem('- [ ] **bold** and `code`\r\n- [ ] two\r\n', 0, '**bold** and `code`', true),
      '- [x] **bold** and `code`\r\n- [ ] two\r\n'
    )
  })

  test('refuses when the text at that ordinal differs, ignoring whitespace runs', () => {
    assert.equal(setTaskItem('- [ ] one\n', 0, 'other', true), null)
    assert.equal(setTaskItem('- [ ] one   two\n', 0, ' one two ', true), '- [x] one   two\n')
  })

  test('refuses an ordinal past the last item', () => {
    assert.equal(setTaskItem('- [ ] one\n', 1, 'one', true), null)
    assert.equal(setTaskItem('plain text\n', 0, 'one', true), null)
  })

  test('returns the source unchanged when the item is already in that state', () => {
    const markdown = '- [x] one\n'
    assert.equal(setTaskItem(markdown, 0, 'one', true), markdown)
  })

  test('changes only that marker across a mixed document', () => {
    const markdown = '# T\n\n- [x] a\n- [ ] b\n\ntext - [ ] not an item\n\n- [ ] c\n'
    const next = setTaskItem(markdown, 2, 'c', true)
    assert.equal(next, '# T\n\n- [x] a\n- [ ] b\n\ntext - [ ] not an item\n\n- [x] c\n')
    assert.deepEqual(
      parseTaskItems(next!).map((item) => item.checked),
      [true, false, true]
    )
  })
})
