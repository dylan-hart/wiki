import { afterEach, describe, expect, it } from 'vitest'

import { Editor } from '@tiptap/core'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'

import { WikiBlock } from './wikiBlockNode'
import {
  EMPTY_WHITEBOARD_BODY,
  WhiteboardInsert,
  enclosingWhiteboard,
  insertWhiteboardInto,
  isDrawShortcut,
  isMacPlatform,
  isPenContact,
  pageWhiteboardBytes,
  penInsertRange
} from './whiteboardInsert'

const BOARD = '::block-whiteboard\n```whiteboard\n' + EMPTY_WHITEBOARD_BODY + '\n```\n::'

let editor = null

function createEditor(markdown) {
  editor = new Editor({
    content: markdown,
    contentType: 'markdown',
    extensions: [StarterKit, Markdown, WikiBlock, WhiteboardInsert]
  })
  return editor
}

function findPos(doc, predicate) {
  let found = null
  doc.descendants((node, pos) => {
    if (found === null && predicate(node)) {
      found = pos
    }
  })
  return found
}

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('isMacPlatform', () => {
  it.each([
    [{ platform: 'MacIntel' }, true],
    [{ platform: 'iPad' }, true],
    [{ userAgentData: { platform: 'macOS' }, platform: '' }, true],
    [{ platform: 'Win32' }, false],
    [{ platform: 'Linux x86_64' }, false],
    [undefined, false]
  ])('%o -> %s', (nav, expected) => {
    expect(isMacPlatform(nav)).toBe(expected)
  })
})

describe('isDrawShortcut', () => {
  const base = { code: 'KeyP', altKey: true, shiftKey: false, metaKey: false, ctrlKey: false }

  it('reads Mod as Cmd on macOS and Ctrl elsewhere', () => {
    expect(isDrawShortcut({ ...base, metaKey: true }, true)).toBe(true)
    expect(isDrawShortcut({ ...base, ctrlKey: true }, true)).toBe(false)
    expect(isDrawShortcut({ ...base, ctrlKey: true }, false)).toBe(true)
    expect(isDrawShortcut({ ...base, metaKey: true }, false)).toBe(false)
  })

  it('matches the physical P key whatever character the layout produces', () => {
    expect(isDrawShortcut({ ...base, key: 'π', metaKey: true }, true)).toBe(true)
    expect(isDrawShortcut({ ...base, code: 'KeyO', key: 'p', metaKey: true }, true)).toBe(false)
  })
})

describe('isPenContact', () => {
  it('accepts only the pen tip', () => {
    expect(isPenContact({ pointerType: 'pen', button: 0 })).toBe(true)
    expect(isPenContact({ pointerType: 'pen', button: 5 })).toBe(false)
    expect(isPenContact({ pointerType: 'mouse', button: 0 })).toBe(false)
    expect(isPenContact({ pointerType: 'touch', button: 0 })).toBe(false)
  })
})

describe('penInsertRange', () => {
  it('lands after a non-empty line inside a list item', () => {
    const { state } = createEditor('- one\n- two')
    const pos = findPos(state.doc, (node) => node.isText && node.text === 'one')
    const range = penInsertRange(state.doc, pos + 1)
    const tr = state.tr
    expect(insertWhiteboardInto(tr, range.from, range.to)).not.toBeNull()
    const item = tr.doc.firstChild.firstChild
    expect(item.type.name).toBe('listItem')
    expect(item.child(1).attrs.block).toBe('whiteboard')
  })

  it('keeps the required first paragraph of a list item rather than replacing it', () => {
    const { state } = createEditor('- one')
    const tr = state.tr.delete(3, 6)
    const pos = findPos(tr.doc, (node) => node.type.name === 'paragraph') + 1
    const range = penInsertRange(tr.doc, pos)
    expect(range.from).toBe(range.to)
  })
})

describe('enclosingWhiteboard', () => {
  it('finds the innermost board around a position inside its body', () => {
    const { state } = createEditor('Intro\n\n' + BOARD)
    const textPos = findPos(state.doc, (node) => node.isText && node.text === EMPTY_WHITEBOARD_BODY)
    const found = enclosingWhiteboard(state.doc, textPos + 2)
    expect(found.node.attrs.block).toBe('whiteboard')
    expect(state.doc.nodeAt(found.pos)).toBe(found.node)
    expect(enclosingWhiteboard(state.doc, 2)).toBeNull()
  })
})

describe('pageWhiteboardBytes', () => {
  it('sums the trimmed body bytes of every board, nested ones included', () => {
    const { state } = createEditor(BOARD + '\n\n:::block-tabs\n::block-tab\n' + BOARD + '\n::\n:::')
    expect(pageWhiteboardBytes(state.doc)).toBe(EMPTY_WHITEBOARD_BODY.length * 2)
  })
})

describe('insertWhiteboard command', () => {
  it('serialises to the pinned ::block-whiteboard fence', () => {
    createEditor('')
    expect(editor.commands.insertWhiteboard()).toBe(true)
    expect(editor.getMarkdown().trim()).toBe(BOARD)
  })
})
