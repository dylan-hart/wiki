import { describe, expect, it } from 'vitest'

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'

import { TexMath } from './texMath.js'

/**
 * Builds a headless editor (no DOM mount) with just enough of a schema to parse/render markdown --
 * `Markdown`'s `contentType: 'markdown'` path only needs the schema and `editor.markdown`, not a
 * live ProseMirror view, so this is cheap and does not need jsdom's layout at all.
 */
function buildEditor(content) {
  return new Editor({
    content,
    contentType: 'markdown',
    extensions: [StarterKit, Markdown, TexMath]
  })
}

describe('TexMath', () => {
  it('parses inline TeX into a texMath node', () => {
    const editor = buildEditor('The area is $x^2$ here.')
    let found = null
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'texMath') {
        found = node
      }
    })
    expect(found).not.toBeNull()
    expect(found.attrs).toEqual({ formula: 'x^2', display: false })
    editor.destroy()
  })

  it('parses display TeX into a texMath node with display: true', () => {
    const editor = buildEditor('Formula:\n\n$$x^2 + y^2$$')
    let found = null
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'texMath') {
        found = node
      }
    })
    expect(found).not.toBeNull()
    expect(found.attrs).toEqual({ formula: 'x^2 + y^2', display: true })
    editor.destroy()
  })

  it('round-trips inline and display TeX back to markdown', () => {
    const authored = 'The area is $x^2$ here.\n\n$$x^2 + y^2$$'
    const editor = buildEditor(authored)
    expect(editor.getMarkdown()).toBe(authored)
    editor.destroy()
  })

  it('does not treat ordinary currency prose as a formula', () => {
    const editor = buildEditor('It costs $5 or $10, not a formula.')
    let found = null
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'texMath') {
        found = node
      }
    })
    expect(found).toBeNull()
    expect(editor.getMarkdown()).toBe('It costs $5 or $10, not a formula.')
    editor.destroy()
  })

  it('reloads a saved document identically (save -> reload -> save)', () => {
    const editor = buildEditor('Inline $a+b$ and display $$c+d$$ together.')
    const saved = editor.getMarkdown()
    editor.destroy()

    const reloaded = buildEditor(saved)
    expect(reloaded.getMarkdown()).toBe(saved)
    reloaded.destroy()
  })
})
