import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DROP_FOLDER_ATTR,
  dropFolderAt,
  dropRowOf,
  holdForDrop,
  inDropBand,
  restoreDomPosition
} from './dropTarget'

function row(id, rect = { top: 0, bottom: 40, height: 40 }) {
  const element = document.createElement('div')
  if (id !== undefined) {
    element.setAttribute(DROP_FOLDER_ATTR, id)
  }
  element.getBoundingClientRect = () => rect
  return element
}

function namedList(...ids) {
  const list = document.createElement('div')
  const items = ids.map((id) => {
    const el = document.createElement('div')
    el.id = id
    return el
  })
  return { list, items }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('inDropBand', () => {
  const rect = { top: 100, bottom: 140, height: 40 }

  it('counts the middle half of a row', () => {
    expect(inDropBand(rect, 120)).toBe(true)
    expect(inDropBand(rect, 110)).toBe(true)
    expect(inDropBand(rect, 130)).toBe(true)
  })

  it('leaves the outer quarters to reordering', () => {
    expect(inDropBand(rect, 102)).toBe(false)
    expect(inDropBand(rect, 138)).toBe(false)
  })
})

describe('dropRowOf', () => {
  it('returns the element itself when it carries the attribute', () => {
    const el = row('f1')

    expect(dropRowOf(el)).toBe(el)
  })

  it('finds the labelled child of a wrapping item', () => {
    const li = document.createElement('li')
    const label = row('f1')
    li.append(document.createElement('span'), label)

    expect(dropRowOf(li)).toBe(label)
  })

  it('is null for an unlabelled row and for nothing', () => {
    expect(dropRowOf(row())).toBeNull()
    expect(dropRowOf(null)).toBeNull()
  })
})

describe('holdForDrop', () => {
  it('refuses the swap while the pointer is over the middle of a folder row', () => {
    expect(holdForDrop({ related: row('f1') }, { clientY: 20 })).toBe(false)
  })

  it('allows the swap near a folder row edge', () => {
    expect(holdForDrop({ related: row('f1') }, { clientY: 2 })).toBe(true)
  })

  it('allows the swap over a row that is not a folder', () => {
    expect(holdForDrop({ related: row() }, { clientY: 20 })).toBe(true)
  })

  it('reads the pointer off a touch event', () => {
    expect(holdForDrop({ related: row('f1') }, { changedTouches: [{ clientY: 20 }] })).toBe(false)
  })
})

describe('dropFolderAt', () => {
  function drag(target, { y = 20, sameList = true } = {}) {
    const from = document.createElement('div')
    const item = document.createElement('div')
    from.append(item)
    if (sameList && target) {
      from.append(target)
    }
    document.elementFromPoint = vi.fn(() => target)
    return { from, item, originalEvent: { clientX: 5, clientY: y } }
  }

  it('answers the folder id under the pointer', () => {
    expect(dropFolderAt(drag(row('f1')))).toBe('f1')
  })

  it('answers null for the root row', () => {
    expect(dropFolderAt(drag(row(''), { sameList: false }))).toBeNull()
  })

  it('answers undefined off any folder', () => {
    expect(dropFolderAt(drag(row()))).toBeUndefined()
    expect(dropFolderAt(drag(null))).toBeUndefined()
  })

  it('answers undefined without pointer coordinates', () => {
    expect(dropFolderAt({ originalEvent: {} })).toBeUndefined()
  })

  it('applies the band to a row in the same list only', () => {
    expect(dropFolderAt(drag(row('f1'), { y: 2 }))).toBeUndefined()
    expect(dropFolderAt(drag(row('f1'), { y: 2, sameList: false }))).toBe('f1')
  })

  it('ignores the dragged row itself and anything inside it', () => {
    const event = drag(row('f1'))
    const inner = row('f2')
    event.item.append(inner)
    document.elementFromPoint = vi.fn(() => inner)

    expect(dropFolderAt(event)).toBeUndefined()
  })
})

describe('restoreDomPosition', () => {
  it('puts the dragged row back at its original index', () => {
    const { list, items } = namedList('a', 'b', 'c')
    const [a, b, c] = items
    list.append(b, c, a)

    restoreDomPosition({ item: a, from: list, oldIndex: 0 })

    expect([...list.children].map((el) => el.id)).toEqual(['a', 'b', 'c'])
  })

  it('appends when the original index was last', () => {
    const { list, items } = namedList('a', 'b')
    const [a, b] = items
    list.append(b, a)

    restoreDomPosition({ item: a, from: list, oldIndex: 1 })

    expect([...list.children].map((el) => el.id)).toEqual(['b', 'a'])
  })
})
