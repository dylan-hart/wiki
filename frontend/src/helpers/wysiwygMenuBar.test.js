import { describe, expect, it } from 'vitest'

import en from '../../../backend/locales/en.json'

import { buildMenuBar } from './wysiwygMenuBar'

/**
 * OpenProject #3206: `wysiwygMenuBar.js` built every toolbar item's `title` as a literal hardcoded
 * English string -- never run through `t()` -- despite that `title` doubling as the accessible name
 * `EditorWysiwyg.vue` renders via `:aria-label`. This suite exercises `buildMenuBar` directly (rather
 * than through the full `EditorWysiwyg.vue` mount other suites use) so it can assert the actual
 * translation contract: every `title`, at every nesting level, resolves through the `t` callback
 * against a real `editor.wysiwyg.*` key -- never a bare string the caller's locale can't affect.
 */

const TEXT_COLORS = {
  blue: '#1976D2',
  brown: '#795548',
  green: '#388E3C',
  orange: '#F57C00',
  pink: '#C2185B',
  purple: '#7B1FA2',
  red: '#D32F2F',
  teal: '#00796B',
  yellow: '#F9A825'
}

const HIGHLIGHT_COLORS = {
  blue: '#90CAF9',
  green: '#A5D6A7',
  orange: '#FFCC80',
  pink: '#F48FB1',
  yellow: '#FFF59D'
}

/**
 * A `t` stand-in that resolves strictly against the real `backend/locales/en.json` -- so this suite
 * fails the moment a call site's key drifts from what is actually shipped, the same way a missing key
 * would surface in the running app -- and records every `(key, params)` pair it was called with, so
 * the assertions below can check the calls themselves rather than only their string output.
 */
function createRecordingT() {
  const calls = []
  const t = (key, params) => {
    calls.push({ key, params })
    if (!(key in en)) {
      throw new Error(`missing locale key: ${key}`)
    }
    let value = en[key]
    if (params) {
      for (const [name, val] of Object.entries(params)) {
        value = value.replaceAll(`{${name}}`, val)
      }
    }
    return value
  }
  return { t, calls }
}

function build(t) {
  return buildMenuBar(() => ({ value: null }), {
    TEXT_COLORS,
    HIGHLIGHT_COLORS,
    insertLink: () => {},
    openFileManager: () => {},
    insertBlock: () => {},
    t
  })
}

/** Every non-divider entry, at both the top level and one level of `children`, flattened. */
function flattenEntries(menuBar) {
  const entries = []
  for (const item of menuBar) {
    if (item.type !== 'divider') entries.push(item)
    for (const child of item.children ?? []) {
      if (child.type !== 'divider') entries.push(child)
    }
  }
  return entries
}

describe('buildMenuBar (OpenProject #3206)', () => {
  it('resolves every entry title through t(), never a bare literal', () => {
    const { t, calls } = createRecordingT()
    const menuBar = build(t)

    const entries = flattenEntries(menuBar)
    // -> `align`'s parent entry carries no `title` of its own (only its four children do) -- confirmed
    //    real, not a gap this suite is papering over, so it is excluded rather than asserted on.
    const titled = entries.filter((entry) => entry.key !== 'align')

    expect(titled.length).toBeGreaterThan(0)
    for (const entry of titled) {
      expect(typeof entry.title).toBe('string')
      expect(entry.title.length).toBeGreaterThan(0)
    }

    // -> Every recorded call targeted the real `editor.wysiwyg.*` namespace -- the regression this
    //    task fixes was a hardcoded `'Bold'` etc. with zero `t()` call at all.
    expect(calls.length).toBe(titled.length)
    for (const { key } of calls) {
      expect(key).toMatch(/^editor\.wysiwyg\./)
    }
  })

  it('renders the real English strings when built against actual locale data', () => {
    const { t } = createRecordingT()
    const menuBar = build(t)

    expect(menuBar.find((item) => item.key === 'bold').title).toBe('Bold')
    expect(menuBar.find((item) => item.key === 'italic').title).toBe('Italic')
    const colorItem = menuBar.find((item) => item.key === 'color')
    expect(colorItem.title).toBe('Text Color')
    expect(colorItem.children.find((c) => c.key === 'color-blue').title).toBe('Blue')
    expect(colorItem.children.find((c) => c.key === 'color-remove').title).toBe('Default')
  })

  it('interpolates {level} into each header entry via the same key, headerLevel', () => {
    const { t, calls } = createRecordingT()
    const menuBar = build(t)

    const header = menuBar.find((item) => item.key === 'header')
    const levels = [1, 2, 3, 4, 5, 6]
    for (const level of levels) {
      const child = header.children.find((c) => c.key === `h${level}`)
      expect(child.title).toBe(`Header ${level}`)
    }

    const headerLevelCalls = calls.filter((c) => c.key === 'editor.wysiwyg.headerLevel')
    expect(headerLevelCalls.map((c) => c.params.level)).toEqual(levels)
  })

  it('wires the block entry to the caller’s insertBlock, not an editor command (OpenProject #3396)', () => {
    const { t } = createRecordingT()
    let calls = 0
    const menuBar = buildMenuBar(() => ({ value: null }), {
      TEXT_COLORS,
      HIGHLIGHT_COLORS,
      insertLink: () => {},
      openFileManager: () => {},
      insertBlock: () => {
        calls++
      },
      t
    })
    const block = menuBar.find((item) => item.key === 'block')
    expect(block.title).toBe('Insert Block')
    block.action()
    expect(calls).toBe(1)
  })

  it('is only ever asked to build a plain t function, not a reactive ref, so it stays a pure builder', () => {
    // -> `EditorWysiwyg.vue` wraps this in `computed()` for locale reactivity; the builder itself
    //    stays a plain function of its inputs so that computed can call it fresh on every locale
    //    change without any hidden state of its own.
    const { t: tA } = createRecordingT()
    const { t: tB } = createRecordingT()
    const first = build(tA)
    const second = build(tB)
    expect(first).not.toBe(second)
    expect(first.map((i) => i.title)).toEqual(second.map((i) => i.title))
  })
})
